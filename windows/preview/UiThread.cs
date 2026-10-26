using System;
using System.Threading;
using System.Windows.Forms;

namespace Psarc2gp.Preview
{
    // prevhost.exe calls the handler on whatever thread COM picks: .NET objects are free-threaded to COM,
    // so that's usually an RPC worker in the multithreaded apartment. WinForms and WebView2 need a single
    // STA thread with a message loop, so all window work happens on this one (one per prevhost process).
    static class UiThread
    {
        static readonly object gate = new object();
        static Control invoker;

        public static void Run(Action action)
        {
            Start();
            if (invoker.InvokeRequired) invoker.Invoke(action); else action();
        }

        public static T Run<T>(Func<T> func)
        {
            T result = default;
            Run(() => { result = func(); });
            return result;
        }

        static void Start()
        {
            lock (gate)
            {
                if (invoker != null) return;
                using (var ready = new ManualResetEventSlim())
                {
                    var thread = new Thread(() =>
                    {
                        invoker = new Control();
                        invoker.CreateControl(); // its window ties Invoke to this thread
                        ready.Set();
                        Application.Run(); // runs as long as prevhost does
                    }) { IsBackground = true, Name = "psarc2gp preview" };
                    thread.SetApartmentState(ApartmentState.STA);
                    thread.Start();
                    ready.Wait();
                }
            }
        }
    }
}
