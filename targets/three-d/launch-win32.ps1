$ErrorActionPreference = 'Stop'

try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshBlenderDesktop
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicJobLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedJobLimits
    {
        public BasicJobLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devMode,
        uint flags, uint access, IntPtr security);
    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr security, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedJobLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int stream);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target,
        out IntPtr duplicate, uint access, bool inherit, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private const uint Synchronize = 0x00100000;
    private const uint DesktopAccess = 0x0047; // READOBJECTS | CREATEWINDOW | CREATEMENU | ENUMERATE
    private const uint CreateNoWindow = 0x08000000;
    private const int StartfUseStdHandles = 0x00000100;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    private static void Check(bool success, string operation)
    {
        if (!success)
        {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, operation + " (Win32 " + error + ")");
        }
    }

    private static IntPtr InheritStream(int stream)
    {
        IntPtr self = GetCurrentProcess();
        IntPtr handle;
        Check(DuplicateHandle(self, GetStdHandle(stream), self, out handle, 0, true, 2), "DuplicateHandle");
        return handle;
    }

    private static void BindLauncherLifetime()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        Check(job != IntPtr.Zero, "CreateJobObject");
        try
        {
            var limits = new ExtendedJobLimits();
            limits.Basic.Flags = JobObjectLimitKillOnJobClose;
            Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                Marshal.SizeOf(typeof(ExtendedJobLimits))), "SetInformationJobObject");
            Check(AssignProcessToJobObject(job, GetCurrentProcess()), "AssignProcessToJobObject");
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        // Keep the non-inheritable handle until the launcher exits. Blender joins this job at creation.
    }

    public static void Run(string executable, string commandLine, uint hostPid)
    {
        IntPtr host = OpenProcess(Synchronize, false, hostPid);
        Check(host != IntPtr.Zero, "OpenProcess (Host)");
        IntPtr desktop = IntPtr.Zero;
        var startup = new StartupInfo();
        try
        {
            BindLauncherLifetime();
            startup.Desktop = "DshBlender-" + Guid.NewGuid().ToString("N");
            // CreateDesktop attaches its caller. Exit that thread before closing the desktop handle.
            int desktopError = 0;
            var desktopThread = new Thread(() => {
                desktop = CreateDesktop(startup.Desktop, IntPtr.Zero, IntPtr.Zero, 0, DesktopAccess, IntPtr.Zero);
                if (desktop == IntPtr.Zero) desktopError = Marshal.GetLastWin32Error();
            });
            desktopThread.Start();
            desktopThread.Join();
            if (desktop == IntPtr.Zero) throw new Win32Exception(desktopError, "CreateDesktop");
            startup.Size = Marshal.SizeOf(typeof(StartupInfo));
            startup.Flags = StartfUseStdHandles;
            startup.Input = InheritStream(-10);
            startup.Output = InheritStream(-11);
            startup.Error = InheritStream(-12);
            ProcessInfo blender;
            Check(CreateProcess(executable, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
                true, CreateNoWindow, IntPtr.Zero, null, ref startup, out blender), "CreateProcess (Blender)");
            CloseHandle(blender.Thread);
            try
            {
                uint result = WaitForMultipleObjects(2, new[] { blender.Process, host }, false, uint.MaxValue);
                Check(result < 2, "WaitForMultipleObjects");
            }
            finally
            {
                CloseHandle(blender.Process);
            }
        }
        finally
        {
            if (startup.Input != IntPtr.Zero) CloseHandle(startup.Input);
            if (startup.Output != IntPtr.Zero) CloseHandle(startup.Output);
            if (startup.Error != IntPtr.Zero) CloseHandle(startup.Error);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
            CloseHandle(host);
        }
    }
}
'@
    $executable = $env:DSH_BLENDER_LAUNCH_EXECUTABLE
    $commandLine = $env:DSH_BLENDER_LAUNCH_COMMAND
    $hostPid = [uint32]$env:DSH_BLENDER_LAUNCH_HOST_PID
    Remove-Item Env:DSH_BLENDER_LAUNCH_EXECUTABLE, Env:DSH_BLENDER_LAUNCH_COMMAND, Env:DSH_BLENDER_LAUNCH_HOST_PID
    [DshBlenderDesktop]::Run($executable, $commandLine, $hostPid)
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::WriteLine('DSH_VIEWPORT isolation-error')
    exit 1
}
