// COM interfaces Explorer's preview host (prevhost.exe) talks to, and the few Win32 calls we need.
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Psarc2gp.Preview
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public int message; public IntPtr wParam; public IntPtr lParam; public int time; public int x; public int y; }

    [ComImport, Guid("8895b1c6-b41f-4c1c-a562-0d564250836f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPreviewHandler
    {
        void SetWindow(IntPtr hwnd, ref RECT rect);
        void SetRect(ref RECT rect);
        void DoPreview();
        void Unload();
        void SetFocus();
        void QueryFocus(out IntPtr phwnd);
        [PreserveSig] int TranslateAccelerator(ref MSG pmsg);
    }

    [ComImport, Guid("196bf9a5-b346-4ef0-aa1e-5dcdb76768b1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPreviewHandlerVisuals
    {
        void SetBackgroundColor(uint color);
        void SetFont(IntPtr plf);
        void SetTextColor(uint color);
    }

    [ComImport, Guid("fec87aaf-35f9-447a-adb7-20234491401a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPreviewHandlerFrame
    {
        void GetWindowContext(IntPtr pinfo);
        [PreserveSig] int TranslateAccelerator(ref MSG pmsg);
    }

    [ComImport, Guid("b7d14566-0509-4cce-a71f-0a554233bd9b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IInitializeWithFile
    {
        void Initialize([MarshalAs(UnmanagedType.LPWStr)] string pszFilePath, uint grfMode);
    }

    [ComImport, Guid("fc4801a3-2ba9-11cf-a229-00aa003d7352"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IObjectWithSite
    {
        void SetSite([MarshalAs(UnmanagedType.IUnknown)] object pUnkSite);
        void GetSite(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppvSite);
    }

    [ComImport, Guid("00000114-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IOleWindow
    {
        void GetWindow(out IntPtr phwnd);
        void ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool fEnterMode);
    }

    static class Win32
    {
        public const int S_OK = 0, S_FALSE = 1;
        public const uint GENERIC_READ = 0x80000000, FILE_WRITE_ATTRIBUTES = 0x100;
        public const uint FILE_SHARE_ALL = 7, OPEN_EXISTING = 3;

        [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll")] public static extern IntPtr GetFocus();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        // lastAccess = -1 (0xFFFFFFFF'FFFFFFFF): reads through this handle don't change the file's last access time
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetFileTime(SafeFileHandle file, IntPtr creation, ref long lastAccess, IntPtr lastWrite);
    }
}
