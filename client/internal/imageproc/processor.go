package imageproc

import (
	"bytes"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

// ThumbLevel 表示缩略图画质等级
type ThumbLevel string

const (
	ThumbLevelLow    ThumbLevel = "low"
	ThumbLevelMedium ThumbLevel = "medium"
	ThumbLevelHigh   ThumbLevel = "high"
	ThumbLevelUltra  ThumbLevel = "ultra"
)

// ThumbConfig 定义缩略图生成参数
type ThumbConfig struct {
	Level        ThumbLevel `json:"level"`
	MaxDimension int        `json:"max_dimension"`
	Quality      int        `json:"quality"`
}

const (
	DefaultMaxThumbDimension = 512
	DefaultThumbQuality      = 85
	JpegQuality              = 85
)

// ThumbPresets 缩略图画质等级预设
var ThumbPresets = map[ThumbLevel]ThumbConfig{
	ThumbLevelLow: {
		Level:        ThumbLevelLow,
		MaxDimension: 256,
		Quality:      75,
	},
	ThumbLevelMedium: {
		Level:        ThumbLevelMedium,
		MaxDimension: 384,
		Quality:      80,
	},
	ThumbLevelHigh: {
		Level:        ThumbLevelHigh,
		MaxDimension: 512,
		Quality:      85,
	},
	ThumbLevelUltra: {
		Level:        ThumbLevelUltra,
		MaxDimension: 768,
		Quality:      90,
	},
}

// ParseThumbLevel 将等级字符串或画质数值解析为具体的缩略图配置
// 支持: low, medium, high, ultra, 以及数字别名 1~4、中文 (低/中/高/超高/标清/高清/超清) 或纯数字 quality (10~100)
func ParseThumbLevel(levelStr string) ThumbConfig {
	clean := strings.ToLower(strings.TrimSpace(levelStr))
	if clean == "" {
		return ThumbPresets[ThumbLevelHigh]
	}

	switch clean {
	case "low", "1", "低", "省流", "low-res":
		return ThumbPresets[ThumbLevelLow]
	case "medium", "med", "2", "中", "标准", "标清", "normal":
		return ThumbPresets[ThumbLevelMedium]
	case "high", "3", "高", "高清", "清晰":
		return ThumbPresets[ThumbLevelHigh]
	case "ultra", "max", "4", "超高", "超清", "极致", "原画", "best":
		return ThumbPresets[ThumbLevelUltra]
	}

	// 尝试解析纯数字质量 (例如 "80" 或 "90")
	if q, err := strconv.Atoi(clean); err == nil {
		if q >= 1 && q <= 4 {
			switch q {
			case 1:
				return ThumbPresets[ThumbLevelLow]
			case 2:
				return ThumbPresets[ThumbLevelMedium]
			case 3:
				return ThumbPresets[ThumbLevelHigh]
			case 4:
				return ThumbPresets[ThumbLevelUltra]
			}
		}
		if q >= 10 && q <= 100 {
			// 作为自定义 JPEG Quality，采用默认 512px 分辨率
			return ThumbConfig{
				Level:        ThumbLevelHigh,
				MaxDimension: DefaultMaxThumbDimension,
				Quality:      q,
			}
		}
	}

	// 无法识别时安全回退到默认 high
	return ThumbPresets[ThumbLevelHigh]
}

// ProcessedImage 包含去 EXIF 后的主图与高质量缩略图的 JPEG 二进制数据
type ProcessedImage struct {
	JpegData  []byte
	ThumbData []byte
}

// DecodeImage 根据扩展名与文件流解码图片 (支持 JPG, PNG, GIF, WebP)
// 具备容错回退机制：当扩展名与真实图片格式不匹配 (伪后缀) 时，自动嗅探真实格式并解码
func DecodeImage(filePath string) (image.Image, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("打开文件失败: %w", err)
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(filePath))
	img, primaryErr := decodeByExt(file, ext)
	if primaryErr == nil {
		return img, nil
	}

	// 扩展名解码失败时，回退并复位指针尝试格式自动嗅探
	fallbackImg, fallbackErr := fallbackDecode(file)
	if fallbackErr == nil {
		return fallbackImg, nil
	}

	return nil, fmt.Errorf("解码图片失败 (按后缀: %v; 嗅探回退: %v)", primaryErr, fallbackErr)
}

func decodeByExt(file *os.File, ext string) (image.Image, error) {
	switch ext {
	case ".jpg", ".jpeg":
		return jpeg.Decode(file)
	case ".png":
		return png.Decode(file)
	case ".gif":
		g, err := gif.DecodeAll(file)
		if err != nil {
			return nil, fmt.Errorf("解码 GIF 失败: %w", err)
		}
		if len(g.Image) == 0 {
			return nil, fmt.Errorf("GIF 帧数为空")
		}
		return g.Image[0], nil
	case ".webp":
		return webp.Decode(file)
	default:
		img, _, err := image.Decode(file)
		if err != nil {
			return nil, fmt.Errorf("不支持的图片格式: %w", err)
		}
		return img, nil
	}
}

func fallbackDecode(file *os.File) (image.Image, error) {
	// 1. 尝试 image.Decode (依据标准库 magic 签名自动匹配 jpeg/png/gif)
	if _, err := file.Seek(0, 0); err == nil {
		if img, _, err := image.Decode(file); err == nil {
			return img, nil
		}
	}
	// 2. 尝试 webp 解码
	if _, err := file.Seek(0, 0); err == nil {
		if img, err := webp.Decode(file); err == nil {
			return img, nil
		}
	}
	// 3. 尝试 jpeg 解码 (容错部分非标准文件头)
	if _, err := file.Seek(0, 0); err == nil {
		if img, err := jpeg.Decode(file); err == nil {
			return img, nil
		}
	}
	// 4. 尝试 png 解码
	if _, err := file.Seek(0, 0); err == nil {
		if img, err := png.Decode(file); err == nil {
			return img, nil
		}
	}
	// 5. 尝试 gif 解码
	if _, err := file.Seek(0, 0); err == nil {
		if g, err := gif.DecodeAll(file); err == nil && len(g.Image) > 0 {
			return g.Image[0], nil
		}
	}
	return nil, fmt.Errorf("无法识别图片真实内容格式")
}

// GenerateThumbnail 将原图等比例缩放至最长边 ≤ maxDim
func GenerateThumbnail(src image.Image, maxDim int) image.Image {
	bounds := src.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()

	if w <= 0 || h <= 0 {
		return src
	}

	// 如果尺寸本身就小于目标缩略图尺寸，直接返回原图
	if w <= maxDim && h <= maxDim {
		return src
	}

	var targetW, targetH int
	if w > h {
		targetW = maxDim
		targetH = int(float64(h) * float64(maxDim) / float64(w))
	} else {
		targetH = maxDim
		targetW = int(float64(w) * float64(maxDim) / float64(h))
	}

	if targetW < 1 {
		targetW = 1
	}
	if targetH < 1 {
		targetH = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, targetW, targetH))
	// 使用高质量双三次滤波 (CatmullRom) 进行下采样，显著提升下采样细节锐利度与边缘清晰度
	draw.CatmullRom.Scale(dst, dst.Rect, src, bounds, draw.Over, nil)
	return dst
}

// ProcessImage 完整处理流程：解码、重编码主图 (去 EXIF)、生成并编码高质量缩略图
// 支持可选传入 ThumbConfig；若未传入，默认采用 high 画质等级 (512px, 85 质量)
func ProcessImage(filePath string, thumbOpts ...ThumbConfig) (*ProcessedImage, error) {
	srcImg, err := DecodeImage(filePath)
	if err != nil {
		return nil, err
	}

	// 1. 重新编码主图为 JPEG (剥离所有 EXIF 元数据)
	var mainBuf bytes.Buffer
	if err := jpeg.Encode(&mainBuf, srcImg, &jpeg.Options{Quality: JpegQuality}); err != nil {
		return nil, fmt.Errorf("编码主图 JPEG 失败: %w", err)
	}

	// 2. 确定缩略图参数
	cfg := ThumbPresets[ThumbLevelHigh]
	if len(thumbOpts) > 0 {
		cfg = thumbOpts[0]
		if cfg.MaxDimension <= 0 {
			cfg.MaxDimension = DefaultMaxThumbDimension
		}
		if cfg.Quality <= 0 {
			cfg.Quality = DefaultThumbQuality
		}
	}

	// 3. 生成缩略图并编码
	thumbImg := GenerateThumbnail(srcImg, cfg.MaxDimension)
	var thumbBuf bytes.Buffer
	if err := jpeg.Encode(&thumbBuf, thumbImg, &jpeg.Options{Quality: cfg.Quality}); err != nil {
		return nil, fmt.Errorf("编码缩略图 JPEG 失败: %w", err)
	}

	return &ProcessedImage{
		JpegData:  mainBuf.Bytes(),
		ThumbData: thumbBuf.Bytes(),
	}, nil
}
