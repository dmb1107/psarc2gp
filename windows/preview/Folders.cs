using System;
using System.IO;

namespace Psarc2gp.Preview
{
    // Kept apart from anything that touches WebView2: the assembly resolver uses it before WebView2 loads.
    static class Folders
    {
        // windows\preview\bin, where the add-in and the WebView2 assemblies are
        public static readonly string Bin = Path.GetDirectoryName(typeof(Folders).Assembly.Location);

        // the psarc2gp folder: the preview page (windows\preview\web) and alphaTab (node_modules) are under it
        public static readonly string Project = Path.GetFullPath(Path.Combine(Bin, "..", "..", ".."));

        public static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "psarc2gp");

        public static void Log(string message)
        {
            try
            {
                Directory.CreateDirectory(Data);
                File.AppendAllText(Path.Combine(Data, "preview.log"), $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}\r\n");
            }
            catch { }
        }
    }
}
