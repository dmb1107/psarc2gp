// Explorer preview pane handler for Guitar Pro (.gp) files. Explorer creates it in prevhost.exe when a
// .gp is selected with the preview pane open; the preview itself is a web page (web/) in WebView2.
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace Psarc2gp.Preview
{
    [ComVisible(true), Guid(Clsid), ClassInterface(ClassInterfaceType.None), ProgId("Psarc2gp.GpPreview")]
    public sealed class GpPreviewHandler : IPreviewHandler, IPreviewHandlerVisuals, IInitializeWithFile, IObjectWithSite, IOleWindow
    {
        public const string Clsid = "97b4eb14-d693-49c4-b493-63f71eda831f";

        // prevhost.exe's folder is System32, so the CLR wouldn't find the WebView2 assemblies next to ours
        static GpPreviewHandler()
        {
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
            {
                var file = Path.Combine(Folders.Bin, new AssemblyName(e.Name).Name + ".dll");
                return File.Exists(file) ? Assembly.LoadFrom(file) : null;
            };
        }

        string path;
        IntPtr parent, window;
        RECT bounds;
        object site;
        Color? background, foreground;
        PreviewControl control; // created, used and disposed on UiThread only

        public void Initialize(string pszFilePath, uint grfMode) => path = pszFilePath;

        public void SetWindow(IntPtr hwnd, ref RECT rect)
        {
            parent = hwnd;
            bounds = rect;
            UiThread.Run(() =>
            {
                if (control != null) Win32.SetParent(control.Handle, parent);
                Place();
            });
        }

        public void SetRect(ref RECT rect)
        {
            bounds = rect;
            UiThread.Run(Place);
        }

        public void DoPreview()
        {
            UiThread.Run(() =>
            {
                control?.Dispose();
                // Explorer passes white and black even in dark mode, so Windows' app theme decides light or
                // dark; Explorer's colours are used when they agree with it
                var dark = AppsUseDarkTheme();
                var agree = background.HasValue && foreground.HasValue && (background.Value.GetBrightness() < 0.5f) == dark;
                control = new PreviewControl(
                    agree ? background.Value : dark ? Color.FromArgb(0x19, 0x19, 0x19) : Color.White, // #191919: Explorer's dark background
                    agree ? foreground.Value : dark ? Color.White : Color.FromArgb(0x1b, 0x1b, 0x1b));
                window = control.Handle;
                Win32.SetParent(window, parent);
                Place();
                control.Visible = true;
                control.Open(path);
            });
        }

        public void Unload()
        {
            UiThread.Run(() =>
            {
                control?.Dispose();
                control = null;
            });
            window = IntPtr.Zero;
            path = null;
        }

        public void SetFocus() => UiThread.Run(() => control?.Focus());

        public void QueryFocus(out IntPtr phwnd) => phwnd = UiThread.Run(Win32.GetFocus);

        // let Explorer handle its own shortcuts (F5, Alt+P, ...)
        public int TranslateAccelerator(ref MSG pmsg) => site is IPreviewHandlerFrame frame ? frame.TranslateAccelerator(ref pmsg) : Win32.S_FALSE;

        // COLORREF is 0x00BBGGRR
        public void SetBackgroundColor(uint color) => background = Color.FromArgb((int)(color & 0xFF), (int)((color >> 8) & 0xFF), (int)((color >> 16) & 0xFF));
        public void SetTextColor(uint color) => foreground = Color.FromArgb((int)(color & 0xFF), (int)((color >> 8) & 0xFF), (int)((color >> 16) & 0xFF));
        public void SetFont(IntPtr plf) { }

        public void SetSite(object pUnkSite) => site = pUnkSite;

        public void GetSite(ref Guid riid, out object ppvSite) => ppvSite = site;

        public void GetWindow(out IntPtr phwnd) => phwnd = window != IntPtr.Zero ? window : parent;

        public void ContextSensitiveHelp(bool fEnterMode) => throw new NotImplementedException();

        static bool AppsUseDarkTheme()
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                return key?.GetValue("AppsUseLightTheme") is int light && light == 0;
        }

        void Place()
        {
            control?.SetBounds(bounds.Left, bounds.Top, Math.Max(0, bounds.Right - bounds.Left), Math.Max(0, bounds.Bottom - bounds.Top));
        }
    }
}
