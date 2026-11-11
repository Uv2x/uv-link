// Uv Link app-audio helper: captures the sound of ONE program (and its child processes) with
// Windows' process loopback (Windows 10 2004+) and writes it to stdout as raw PCM:
// 48000 Hz, 2 channels, 16-bit little-endian. Exits when stdin closes (Uv Link stopped it).
//
//   UvLinkAppAudio.exe --hwnd <window handle>   capture the program that owns this window
//   UvLinkAppAudio.exe --pid <process id>       capture this process
//
// Built with the C# 5 compiler that ships with Windows (scripts/build-app-audio.mjs).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class UvLinkAppAudio
{
    const int SampleRate = 48000;
    const int Channels = 2;
    const int BitsPerSample = 16;

    [MTAThread]
    static int Main(string[] args)
    {
        try
        {
            uint pid = ParsePid(args);
            if (pid == 0)
            {
                Console.Error.WriteLine("usage: UvLinkAppAudio --hwnd <handle> | --pid <id>");
                return 2;
            }
            // Uv Link closes our stdin when the cast ends (or when it quits): stop then.
            var done = new ManualResetEvent(false);
            var stdinWatcher = new Thread(delegate ()
            {
                try { Console.OpenStandardInput().CopyTo(Stream.Null); } catch { }
                done.Set();
            });
            stdinWatcher.IsBackground = true;
            stdinWatcher.Start();
            Capture(pid, done);
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("app audio failed: " + e.Message);
            return 1;
        }
    }

    static uint ParsePid(string[] args)
    {
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--pid") return uint.Parse(args[i + 1]);
            if (args[i] == "--hwnd")
            {
                uint pid;
                GetWindowThreadProcessId(new IntPtr(long.Parse(args[i + 1])), out pid);
                return pid;
            }
        }
        return 0;
    }

    static void Capture(uint pid, WaitHandle done)
    {
        IAudioClient client = Activate(pid);

        var format = new WAVEFORMATEX();
        format.wFormatTag = 1; // PCM
        format.nChannels = Channels;
        format.nSamplesPerSec = SampleRate;
        format.wBitsPerSample = BitsPerSample;
        format.nBlockAlign = (ushort)(Channels * BitsPerSample / 8);
        format.nAvgBytesPerSec = (uint)(SampleRate * format.nBlockAlign);
        format.cbSize = 0;

        const uint LOOPBACK = 0x00020000, EVENTCALLBACK = 0x00040000, AUTOCONVERTPCM = 0x80000000, SRC_DEFAULT_QUALITY = 0x08000000;
        // 20 ms buffer: low delay; the event fires every ~10 ms.
        Check(client.Initialize(0, LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, 200000, 0, ref format, IntPtr.Zero), "Initialize");

        var ready = new AutoResetEvent(false);
        Check(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");

        object service;
        Guid captureId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        Check(client.GetService(ref captureId, out service), "GetService");
        var capture = (IAudioCaptureClient)service;

        Stream output = Console.OpenStandardOutput();
        byte[] chunk = new byte[0];
        Check(client.Start(), "Start");
        var waits = new WaitHandle[] { done, ready };
        try
        {
            while (WaitHandle.WaitAny(waits, 200) != 0)
            {
                uint packet;
                while (capture.GetNextPacketSize(out packet) == 0 && packet > 0)
                {
                    IntPtr data;
                    uint frames, flags;
                    ulong devicePosition, qpcPosition;
                    Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition), "GetBuffer");
                    int bytes = (int)frames * format.nBlockAlign;
                    if (chunk.Length < bytes) chunk = new byte[bytes];
                    const uint SILENT = 0x2;
                    if ((flags & SILENT) != 0) Array.Clear(chunk, 0, bytes);
                    else Marshal.Copy(data, chunk, 0, bytes);
                    capture.ReleaseBuffer(frames);
                    output.Write(chunk, 0, bytes);
                }
                output.Flush();
            }
        }
        catch (IOException)
        {
            // Uv Link stopped reading: done.
        }
        finally
        {
            client.Stop();
        }
    }

    // ------------------------------------------------------------------ Activation

    static IAudioClient Activate(uint pid)
    {
        var parameters = new AUDIOCLIENT_ACTIVATION_PARAMS();
        parameters.ActivationType = 1; // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
        parameters.TargetProcessId = pid;
        parameters.ProcessLoopbackMode = 0; // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE

        IntPtr paramsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(AUDIOCLIENT_ACTIVATION_PARAMS)));
        IntPtr variantPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(PROPVARIANT_BLOB)));
        try
        {
            Marshal.StructureToPtr(parameters, paramsPtr, false);
            var variant = new PROPVARIANT_BLOB();
            variant.vt = 65; // VT_BLOB
            variant.cbSize = (uint)Marshal.SizeOf(typeof(AUDIOCLIENT_ACTIVATION_PARAMS));
            variant.pBlobData = paramsPtr;
            Marshal.StructureToPtr(variant, variantPtr, false);

            var handler = new ActivationHandler();
            IActivateAudioInterfaceAsyncOperation operation;
            Guid audioClientId = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            Check(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref audioClientId, variantPtr, handler, out operation), "ActivateAudioInterfaceAsync");
            if (!handler.Done.WaitOne(5000)) throw new TimeoutException("Windows didn't activate process audio capture");

            int result;
            object activated;
            Check(operation.GetActivateResult(out result, out activated), "GetActivateResult");
            Check(result, "activation");
            return (IAudioClient)activated;
        }
        finally
        {
            Marshal.FreeHGlobal(variantPtr);
            Marshal.FreeHGlobal(paramsPtr);
        }
    }

    static void Check(int hr, string what)
    {
        if (hr < 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")");
    }

    // Windows calls this back on another thread, so it must say it's agile (IAgileObject);
    // without that ActivateAudioInterfaceAsync fails with E_ILLEGAL_METHOD_CALL.
    class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            Done.Set();
            return 0;
        }
    }

    // ------------------------------------------------------------------ Win32 / COM declarations

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("Mmdevapi.dll", ExactSpelling = true)]
    static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    // PROPVARIANT holding a BLOB (64-bit layout: vt + 6 reserved bytes, then the BLOB).
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PROPVARIANT_BLOB
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public uint cbSize;
        [FieldOffset(16)] public IntPtr pBlobData;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject
    {
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, ref WAVEFORMATEX format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint paddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}
