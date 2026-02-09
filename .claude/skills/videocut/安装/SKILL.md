---
name: videocut:安装
description: 环境准备。安装依赖、验证环境。触发词：安装、环境准备、初始化
---

<!--
input: 无
output: 环境就绪
pos: 前置 skill，首次使用前运行

架构守护者：一旦我被修改，请同步更新：
1. ../README.md 的 Skill 清单
2. /CLAUDE.md 路由表
-->

# 安装

> 首次使用前的环境准备

## 快速使用

```
用户: 安装环境
用户: 初始化
```

## 依赖清单

| 依赖 | 用途 | 安装命令 |
|------|------|----------|
| Node.js | 运行脚本 | `brew install node` |
| FFmpeg | 视频剪辑 | `brew install ffmpeg` |
| Python 3.8+ | FunASR 模型运行 | 系统自带 |
| FunASR | 本地语音转录 | `pip install funasr modelscope torch torchaudio` |

## 安装流程

```
1. 安装 Node.js + FFmpeg
       ↓
2. 安装 Python 依赖（FunASR）
       ↓
3. 验证环境
```

## 执行步骤

### 1. 安装基础依赖

```bash
# macOS
brew install node ffmpeg

# 验证
node -v
ffmpeg -version
```

### 2. 安装 FunASR

```bash
pip install funasr modelscope torch torchaudio
```

> 首次运行转录时会自动下载模型（约 2GB），请确保网络畅通。
> 模型下载后缓存在本地，后续使用无需网络。

### 3. 验证环境

```bash
# 检查 Node.js
node -v

# 检查 FFmpeg
ffmpeg -version

# 检查 Python
python3 -c "import funasr; print('FunASR 版本:', funasr.__version__)"
```

## 常见问题

### Q1: pip install 报错？

```bash
# 尝试使用 pip3
pip3 install funasr modelscope torch torchaudio

# 或指定 Python 版本
python3 -m pip install funasr modelscope torch torchaudio
```

### Q2: ffmpeg 命令找不到

```bash
which ffmpeg  # 应该输出路径
# 如果没有，重新安装：brew install ffmpeg
```

### Q3: 文件名含冒号报错

FFmpeg 命令需加 `file:` 前缀：

```bash
ffmpeg -i "file:2026:01:26 task.mp4" ...
```

### Q4: 模型下载慢？

FunASR 模型从 ModelScope 下载，国内网络通常较快。如果下载慢，可以设置镜像：

```bash
export MODELSCOPE_CACHE=~/.cache/modelscope
```
