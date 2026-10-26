// The preview: WebView2 showing web/index.html, which reads the .gp with alphaTab. The page and alphaTab
// are served from the psarc2gp folder; the .gp itself from memory, so the page needs no file access.
using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Psarc2gp.Preview
{
    sealed class PreviewControl : UserControl
    {
        const string AppHost = "app.psarc2gp", FileHost = "file.psarc2gp";

        // one browser environment per prevhost process, reused by the following previews
        static Task<CoreWebView2Environment> environment;
        static bool loaderFolderSet;

        readonly WebView2 web;
        readonly Label message;
        readonly Color background, foreground;

        public PreviewControl(Color background, Color foreground)
        {
            this.background = background;
            this.foreground = foreground;
            BackColor = background;
            ForeColor = foreground;
            message = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Visible = false };
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = background };
            Controls.Add(web);
            Controls.Add(message);
        }

        public async void Open(string path)
        {
            try
            {
                var gp = ReadWithoutTouchingAccessTime(path);
                if (environment == null || environment.IsFaulted) environment = CreateEnvironment();
                var env = await environment;
                if (IsDisposed) return;
                await web.EnsureCoreWebView2Async(env);
                if (IsDisposed) return;

                var core = web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("PSARC2GP_PREVIEW_DEVTOOLS") == "1";
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false; // no F5 reload, Ctrl+F, Ctrl+P in a preview
                core.SetVirtualHostNameToFolderMapping(AppHost, Folders.Project, CoreWebView2HostResourceAccessKind.Allow);
                core.AddWebResourceRequestedFilter($"https://{FileHost}/*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += (s, e) => e.Response = env.CreateWebResourceResponse(
                    new MemoryStream(gp), 200, "OK", $"Content-Type: application/octet-stream\nAccess-Control-Allow-Origin: https://{AppHost}");
                core.NewWindowRequested += (s, e) => e.Handled = true;
                core.NavigationStarting += (s, e) => e.Cancel = !e.Uri.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase);
                core.Navigate($"https://{AppHost}/windows/preview/web/index.html?bg={Hex(background)}&fg={Hex(foreground)}");
            }
            catch (Exception ex)
            {
                if (IsDisposed) return; // the user moved on to another file while this one loaded
                Folders.Log($"{path}: {ex}");
                web.Visible = false;
                message.Text = "This file can't be previewed.\n\n" + ex.Message;
                message.Visible = true;
            }
        }

        static Task<CoreWebView2Environment> CreateEnvironment()
        {
            // WebView2Loader.dll is in this add-in's folder, not next to prevhost.exe
            if (!loaderFolderSet) CoreWebView2Environment.SetLoaderDllFolderPath(Path.Combine(Folders.Bin, "runtimes", "win-x64", "native"));
            loaderFolderSet = true;
            return CoreWebView2Environment.CreateAsync(null, Path.Combine(Folders.Data, "WebView2"));
        }

        // A preview isn't an access: people sort their songs by Explorer's "Date accessed", which a plain
        // read updates on NTFS. (Some drives, Google Drive's for one, don't keep that date at all.)
        static byte[] ReadWithoutTouchingAccessTime(string path)
        {
            if (!IsNtfs(path)) return File.ReadAllBytes(path);
            var handle = Win32.CreateFile(path, Win32.GENERIC_READ | Win32.FILE_WRITE_ATTRIBUTES, Win32.FILE_SHARE_ALL, IntPtr.Zero, Win32.OPEN_EXISTING, 0, IntPtr.Zero);
            if (handle.IsInvalid) return File.ReadAllBytes(path); // e.g. a read-only file: the date can't be kept
            using (var stream = new FileStream(handle, FileAccess.Read))
            {
                long keep = -1;
                Win32.SetFileTime(handle, IntPtr.Zero, ref keep, IntPtr.Zero);
                var data = new byte[stream.Length];
                for (int read = 0, n; read < data.Length; read += n)
                    if ((n = stream.Read(data, read, data.Length - read)) == 0) throw new EndOfStreamException();
                return data;
            }
        }

        static bool IsNtfs(string path)
        {
            try { return new DriveInfo(Path.GetPathRoot(path)).DriveFormat == "NTFS"; }
            catch { return false; } // network paths
        }

        static string Hex(Color c) => $"{c.R:x2}{c.G:x2}{c.B:x2}";
    }
}
