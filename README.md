# FilmWhisper

FilmWhisper 是一个面向浏览器的胶片模拟编辑器，部署为静态 GitHub Pages 应用。图片只在浏览器本地解码与处理，不上传到服务器。

## 页面功能对齐报告

### 布局对齐

- 顶部工作栏：撤销、重做、原图、重置、导出、主题切换。
- 左侧胶片库：胶片、历史、收藏三个标签；搜索胶片、收藏胶片、打开图片、胶片卡片预览。
- 中央工作区：Develop / Print / Crop 模式，画布预览，适合窗口、缩放、前后对比、全屏。
- 右侧检查器：可折叠的 Light、Color、Film、Grain、Halation、Lens、Frame、Regional Tone、Encoded Grade、Screen Conversion、Selective、Histogram、Crop & Rotate、Output 分组。
- 移动端：左右面板变为抽屉，画布保持主操作区域。

### 功能对齐

| 分组 | 已实现功能 |
| --- | --- |
| Light | 曝光、对比度、高光、阴影 |
| Color | 色温、色调、饱和度、自然饱和度 |
| Film | 胶片格式、胶片强度、Push / Pull、漂白旁路、Film Age |
| Grain | 颗粒数量、颗粒大小、彩色颗粒 |
| Halation | 晕光、回返光、Halo Colour |
| Lens | 暗角、畸变参数、滤镜选择 |
| Frame | Carrier / Emulsion / Mount / Social 边框样式与大小 |
| Regional Tone | Shadows / Midtones / Highlights 区域，Warmth、Tint、Level |
| Encoded Grade | Log / Linear / RGB / Luma / Chroma / OKLab 曲线、对比度、饱和度、Auto Levels |
| Screen Conversion | Negative Viewing、Viewing Illuminant、Paper Grade、Screen Exposure、Enlarger、Printer Preflash |
| Selective | Subject、Range、Softness、Edge、Feather、色彩空间、Add Filter |
| Histogram | 阴影 / 中间调 / 高光可视化 |
| Crop & Rotate | 比例、校正、90°旋转、水平翻转、适合画布 |
| Output | JPEG / PNG / WebP、质量、输出介质 |
| 编辑工作流 | 本地打开、拖放、预设、原图预览、前后对比、撤销/重做、保存/载入本机设置、全屏、导出 |

### 设计对齐原则

- 保留照片编辑器的三栏工作台结构，不使用营销型首屏，让画布和主要操作直接进入第一视口。
- 使用低亮度中性背景、细边框、紧凑检查器和胶片缩略色块，突出照片本身。
- 用暖橙作为主要操作色，用蓝色作为焦点状态，保证滑杆、按钮和当前胶片状态在深色界面中清晰。
- 所有状态、设置和图片处理在本地完成，页面不显示实现来源、原始文件名或与编辑无关的说明。

## GitHub Pages

仓库根目录是静态入口，直接使用 `index.html` 即可。若使用 GitHub Actions 部署 Pages，可在仓库 Settings → Pages 中选择 GitHub Actions；也可以选择 `main` 分支的根目录作为 Pages 来源。

预期地址：`https://lzq1206.github.io/FilmWhisper/`

## 许可

项目沿用仓库中的 GPL-3.0 许可。
