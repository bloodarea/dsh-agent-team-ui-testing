# Blender 运行时配置

3D（`three-d`）目标的运行环境是 Blender。本文说明如何在 Linux、Windows、macOS 上安装和配置一个可被检测的 Blender 实例，以及怎样判断它的 GPU 路径是否真的可用。

Linux 部分为**本机实测**；Windows 与 macOS 部分依据官方发布物和已知边界给出，**未经本机实测**，见[验证状态](#验证状态)。

## 安装

Blender 官方发布版以归档形式提供，解压即用、不写系统目录、不需要 root。这是插件环境的推荐形态：路径可预测，版本可核对，卸载即删目录。

从 [download.blender.org/release](https://download.blender.org/release/) 选取版本目录下载。4.5 是 LTS 系列，发布物为：

| 平台 | 归档 |
| --- | --- |
| Linux x64 | `blender-4.5.9-linux-x64.tar.xz` |
| Windows x64 | `blender-4.5.9-windows-x64.zip` |
| Windows arm64 | `blender-4.5.9-windows-arm64.zip` |
| macOS arm64 | `blender-4.5.9-macos-arm64.dmg` |
| macOS x64 | `blender-4.5.9-macos-x64.dmg` |

### Linux

```sh
mkdir -p ~/opt && cd ~/opt
curl -LO https://download.blender.org/release/Blender4.5/blender-4.5.9-linux-x64.tar.xz
tar -xf blender-4.5.9-linux-x64.tar.xz && rm blender-4.5.9-linux-x64.tar.xz
~/opt/blender-4.5.9-linux-x64/blender --version
```

解压后约 1.2 GB。不需要 `sudo`，也不依赖发行版包管理器。

### Windows

两种安装形态都可用，发现方式不同：

| 形态 | 发现方式 |
| --- | --- |
| 官方安装包（`.msi`） | 读注册表 `Uninstall` 项的 `InstallLocation` |
| 便携归档（`.zip` 解压） | 放进 `PATH`，或用 `DSH_UI_TESTING_BLENDER` 指定 |

安装包版不需要把它加进 `PATH`：适配器先查注册表，从
`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`（含 `WOW6432Node`）与
`HKCU` 对应项里按 `DisplayName` 匹配 `Blender`，取 `InstallLocation` 拼出 `blender.exe`，
多个安装按 `DisplayVersion` 从新到旧取第一个。

便携版解压到固定位置（例如 `%LOCALAPPDATA%\Programs\blender-5.3`）后，要么把该目录加入 `PATH`，
要么用 `DSH_UI_TESTING_BLENDER` 指向 `blender.exe`。不要和 Microsoft Store 分发版混用。

Windows 不需要 Xvfb，但**必须用 GUI 模式**：`gpu` 模块在 `-b` 下不可用，视口必须在一个真实的
顶层窗口里绘制。为了让它不打扰桌面，适配器做两件事：

1. `-p -10000 -10000` 把窗口放到屏幕外；
2. 进程启动后把窗口标记为 `WS_EX_TOOLWINDOW`（并清掉 `WS_EX_APPWINDOW`），再从任务栏与
   Alt-Tab 中移除——只放屏幕外的窗口仍会留下任务栏按钮。

第 2 步不能改用 `SW_HIDE`：窗口真正隐藏后 Blender 不再派发 `POST_PIXEL` 绘制回调，帧就取不到。
换样式后窗口保持 mapped，绘制照常（已实测）。换样式是尽力而为，失败时只退化成一个任务栏按钮，
不影响出帧。首次运行若弹出 Windows 防火墙或 SmartScreen 对话框，需要先手工放行。

### macOS

打开 `.dmg`，把 `Blender.app` 拖到 `/Applications`。首次启动若被 Gatekeeper 拦截，在「系统设置 → 隐私与安全性」放行。Apple Silicon 用 arm64 归档，Intel Mac 用 x64 归档。

### 发行版包管理器不适合作为适配器环境

Debian/Ubuntu 源里的 `blender` 版本显著落后（Ubuntu 24.04 为 `4.0.2+dfsg-1ubuntu8`），且安装需要 root；这两个条件都不利于版本核对和可重复。Snap/Flatpak 同理：沙箱会改变文件系统可见范围，影响后续对资产与工程文件的访问。**需要固定版本时优先用官方归档。**

## 配置

### 无头与 GUI

适配器通常以无头方式驱动实例，因为无头不依赖显示会话，也不和用户的桌面争焦点：

```sh
blender -b --factory-startup --python script.py
```

- `-b` / `--background`：无头模式，不创建窗口。
- `--factory-startup`：忽略用户偏好与启动文件，让每次运行从同一状态开始。做自动化时应始终加上，否则结果会被用户的 `preferences` 和 `startup.blend` 影响。
- `--python`：执行给定脚本。参数顺序影响语义，把 `--render-output` 放在工程文件之前、`--render-frame` 放在之后。

需要人看着调参时再用 GUI，两者共用同一份偏好设置。

### 渲染引擎

| 引擎 | 依赖 | 用途 |
| --- | --- | --- |
| Cycles | CPU 或 GPU 计算后端（CUDA / OptiX / HIP / oneAPI / Metal） | 最终出图，质量优先 |
| EEVEE Next | OpenGL 4.3 或 Vulkan 1.2，且要求 SSBO 绑定数 ≥ 12 | 快速出图与视口 |
| Workbench | 同 EEVEE 的图形路径 | 建模过程预览 |

Cycles 不经过 GPU 光栅化管线，因此**在虚拟机和远程环境里通常是最稳的选择**：只要 CPU 可用就能出图。EEVEE 与 Workbench 的可用性取决于宿主显卡路径，见下一节。

### GPU 后端选择

```sh
blender --gpu-backend opengl    # 默认
blender --gpu-backend vulkan
```

取值只有 `opengl` 与 `vulkan` 两个。其他写法（包括 `metal`、`none`）会报 `Unrecognized GPU backend`；该错误不会终止进程，脚本仍会继续执行，因此**不能靠退出码判断后端是否被接受**，必须检查 stderr。需要判断某个后端在某台机器上能不能用，读渲染器身份即可：

```sh
blender --factory-startup --python-expr "import gpu; print(gpu.platform.renderer_get())"
```

这行**必须在有显示会话的模式下运行**：`gpu` 模块的查询需要真实 GL 上下文，加 `-b` 会报 `SystemError: GPU functions for drawing are not available in background mode`。无显示会话时改用下面的 EGL 探测。

输出里出现 `llvmpipe` 表示软件光栅化，出现真实显卡厂商名表示硬件路径。

无显示会话（或不想启动 Blender）时，直接向 Mesa 的 EGL 取同一份读数：

```sh
python3 - <<'PY'
import ctypes, os
egl = ctypes.CDLL("libEGL.so.1"); gbm = ctypes.CDLL("libgbm.so.1")
gbm.gbm_create_device.restype = ctypes.c_void_p
gbm.gbm_create_device.argtypes = [ctypes.c_int]
fd = os.open("/dev/dri/renderD128", os.O_RDWR)
dev = gbm.gbm_create_device(fd)
egl.eglGetPlatformDisplay.restype = ctypes.c_void_p
egl.eglGetPlatformDisplay.argtypes = [ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
disp = egl.eglGetPlatformDisplay(0x31D7, ctypes.c_void_p(dev), None)  # EGL_PLATFORM_GBM_KHR
egl.eglInitialize.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
maj, mnr = ctypes.c_int(), ctypes.c_int()
egl.eglInitialize(disp, ctypes.byref(maj), ctypes.byref(mnr))
egl.eglBindAPI(0x30A2)                                                 # EGL_OPENGL_API
egl.eglChooseConfig.restype = ctypes.c_int
egl.eglChooseConfig.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
cfg = ctypes.c_void_p(); n = ctypes.c_int()
egl.eglChooseConfig(disp, (ctypes.c_int * 7)(0x3040, 0x0004, 0x3033, 0x0001, 0x3038, 0, 0), ctypes.byref(cfg), 1, ctypes.byref(n))
egl.eglCreateContext.restype = ctypes.c_void_p
egl.eglCreateContext.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
ctx = egl.eglCreateContext(disp, cfg, None, (ctypes.c_int * 3)(0x3098, 2, 0x3038))
egl.eglMakeCurrent.argtypes = [ctypes.c_void_p] * 4
egl.eglMakeCurrent(disp, None, None, ctx)
proc = egl.eglGetProcAddress
proc.restype = ctypes.c_void_p; proc.argtypes = [ctypes.c_char_p]
get_string = ctypes.CFUNCTYPE(ctypes.c_char_p, ctypes.c_uint)(proc(b"glGetString"))
get_int = ctypes.CFUNCTYPE(None, ctypes.c_uint, ctypes.POINTER(ctypes.c_int))(proc(b"glGetIntegerv"))
print("RENDERER:", get_string(0x1F01).decode())
value = ctypes.c_int(); get_int(0x90DC, ctypes.byref(value))
print("MAX_SSBO_BINDINGS:", value.value)
PY
```

这条探测不启动任何图形应用，直接读出渲染器名和 `MAX_SSBO_BINDINGS`。后一个数字就是判断 EEVEE 能否在机器上运行的依据：低于 12 时硬件路径不可用。

## 虚拟机与虚拟显卡

在虚拟机里装 Blender 是本环境最常见的失败来源，值得单独说明。

开启虚拟化平台的 3D 加速后，客户机拿到的是半虚拟化图形设备（VMware 为 `SVGA3D`，VirtualBox 为 `VMSVGA`），不是物理显卡。这类设备有固定的能力上限：**SVGA3D 的 SSBO 绑定点是 8**（`SVGA3D_MAX_UAVIEWS`），而 Blender 4.x 自 [commit dc8fd30a](https://projects.blender.org/blender/blender/commit/dc8fd30a) 起要求 ≥ 12。

后果是 Blender 判定平台不受支持：

```text
Warning: Unsupported platform as it supports max 8 SSBO binding locations
Warning: Could not find a matching GPU name. Things may not behave as expected.
Detected OpenGL configuration:
Vendor: VMware, Inc.
Renderer: SVGA3D; build: RELEASE;  LLVM;
```

GUI 下会弹出 `Blender - Platform Unsupported` 对话框（按钮为 `Find Latest Drivers` 与 `Continue Anyway`），该对话框是**模态**的，会阻塞 `--python` 脚本执行。无头模式下 EEVEE 与 Workbench 直接段错误退出，Cycles CPU 不受影响。

这台设备同时**不暴露任何 GPU 计算后端**：Cycles 的 CUDA、OptiX、HIP、oneAPI 设备列表全部为空。VMware Workstation 不支持 PCIe 直通，客户机看不到物理显卡；要拿到完整 GPU 只能改用裸机、ESXi 的 VMDirectPath I/O 或 KVM/VFIO 直通。

在虚拟机上出图的处理方式是把图形后端固定为软件光栅化，让 EEVEE 与 Workbench 回到可用状态：

```sh
LIBGL_ALWAYS_SOFTWARE=1 blender
```

这个变量只影响该进程，宿主的桌面合成等其他客户端不受影响。它恢复的是可用性，不是性能：软件光栅化的绝对速度低于真实显卡。

### Linux 上的验证方法

```sh
# 硬件路径是否启用：应无 "No 3D enabled"
journalctl -k -b | grep -i "No 3D enabled"

# X 服务器是否启用直接渲染
grep -E "Direct rendering|Gallium3D XA" ~/.local/share/xorg/Xorg.0.log

# 渲染器身份（需要显示会话，不能加 -b）
blender --factory-startup --python-expr "import gpu; print(gpu.platform.renderer_get())"
```

GL 版本能否达到 4.3 由三个条件共同决定：内核模块 `vmwgfx` ≥ 2.20、虚拟机硬件版本 ≥ 20、Mesa ≥ 22.0。三者满足时渲染器会报 `SVGA3D; build: RELEASE;` 与 `4.3 (Compatibility Profile)`，但 SSBO 上限仍是 8，因此**能创建 GL 上下文不等于 EEVEE 能用**。

## 验证

判断一份安装是否可用于自动化，逐项取证而不是猜测。第一项是版本，第二项是真实出图；渲染器身份另用上文的 EGL 探测或 GUI 模式读取，`gpu` 模块在无头模式下不可用。

```sh
# 1. 版本
blender --version

# 2. 真实出图（引擎可换 CYCLES / BLENDER_EEVEE_NEXT）
blender -b --factory-startup --python-expr "
import bpy
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.render.resolution_x, sc.render.resolution_y = 640, 360
sc.render.filepath = '/tmp/blender-check.png'
bpy.ops.render.render(write_still=True)
print('OK')
"
```

判读规则：

| 现象 | 结论 |
| --- | --- |
| 退出码 0 且写出了图片文件 | 引擎在该机器上可用 |
| 退出码 139 且日志含 `SSBO binding locations` | 图形路径能力不足，换 Cycles 或固定软件光栅化 |
| 退出码 0 但没有图片 | 输出路径未生效，检查 `filepath` 与参数顺序 |
| 日志出现 `Platform Unsupported` | 只影响 EEVEE/Workbench，Cycles 仍可测 |

Cycles 的 GPU 设备清单用同一个入口读：

```sh
blender -b --factory-startup --python-expr "
import bpy
prefs = bpy.context.preferences.addons['cycles'].preferences
for backend in ('CUDA', 'OPTIX', 'HIP', 'ONEAPI'):
    try:
        prefs.compute_device_type = backend
        prefs.get_devices()
        print(backend, [d.name for d in prefs.devices if d.type != 'CPU'])
    except Exception as exc:
        print(backend, 'unavailable', type(exc).__name__)
"
```

## 已知限制

- 虚拟机内 EEVEE 与 Workbench 受 SSBO 上限限制，无法通过客户机配置绕过。
- 无头模式不支持 `bpy.ops.render.opengl()`：它需要真实 GL 上下文，会报 `Cannot use OpenGL render in background mode`。
- 模态对话框会阻塞脚本，自动化场景必须避免触发平台不受支持判定，或使用 `LIBGL_ALWAYS_SOFTWARE=1` 规避。
- Workbench 只读取材质的视口颜色（`material.diffuse_color`），不计算 Principled BSDF。用 Workbench 预览材质颜色属预期行为差异，不是渲染缺陷。

## 验证状态

| 平台 | 安装 | 无头 Cycles | 无头 EEVEE | GUI |
| --- | --- | --- | --- | --- |
| Linux（Ubuntu 24.04，VMware 客户机） | 已实测 | 已实测 | 已实测（软件光栅化） | 已实测 |
| Windows 11（RTX 4070 Ti，Blender 5.3.0 MSI 安装） | 已实测 | 已实测 | 已实测 | 已实测 |
| macOS | 未实测 | 未实测 | 未实测 | 未实测 |

本文的 Linux 读数来自 Ubuntu 24.04、Blender 4.5.9 LTS、VMware SVGA II 虚拟显卡、Mesa 25.2.8。Windows 读数来自 Windows 11、Blender 5.3.0（MSI 安装包）、NVIDIA GeForce RTX 4070 Ti、驱动 591.86。

GUI 模式下的视口出图（`viewport.py`）在 Windows 已实测：把窗口放到 `-p -10000 -10000` 后仍能正常绘制并导出 960×540 PNG。注意 Blender 5.3 的默认 `--gpu-backend` 已由 `opengl` 改为 `vulkan`，需要 OpenGL 时显式传参。
