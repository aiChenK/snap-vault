package imageproc

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestProcessImage(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "snapvault_img_test_*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// 生成一张测试图片: 800x600 的渐变 PNG
	srcImg := image.NewRGBA(image.Rect(0, 0, 800, 600))
	for y := 0; y < 600; y++ {
		for x := 0; x < 800; x++ {
			srcImg.Set(x, y, color.RGBA{
				R: uint8((x * 255) / 800),
				G: uint8((y * 255) / 600),
				B: 128,
				A: 255,
			})
		}
	}

	testPngPath := filepath.Join(tempDir, "test_game_capture.png")
	outFile, err := os.Create(testPngPath)
	if err != nil {
		t.Fatalf("创建测试文件失败: %v", err)
	}
	if err := png.Encode(outFile, srcImg); err != nil {
		t.Fatalf("编码测试 PNG 失败: %v", err)
	}
	outFile.Close()

	// 执行客户端图像处理流程
	res, err := ProcessImage(testPngPath)
	if err != nil {
		t.Fatalf("ProcessImage 执行失败: %v", err)
	}

	if len(res.JpegData) == 0 {
		t.Fatalf("转码后的 JpegData 不能为空")
	}
	if len(res.ThumbData) == 0 {
		t.Fatalf("生成的 ThumbData 不能为空")
	}

	// 验证 JpegData 可被解码
	decodedMain, err := jpeg.Decode(bytes.NewReader(res.JpegData))
	if err != nil {
		t.Fatalf("解码处理后的主图失败: %v", err)
	}
	if decodedMain.Bounds().Dx() != 800 || decodedMain.Bounds().Dy() != 600 {
		t.Errorf("主图分辨率发生意外改变: %dx%d (预期 800x600)",
			decodedMain.Bounds().Dx(), decodedMain.Bounds().Dy())
	}

	// 验证默认 ThumbData 最长边不超过 512px (high 等级)
	decodedThumb, err := jpeg.Decode(bytes.NewReader(res.ThumbData))
	if err != nil {
		t.Fatalf("解码缩略图失败: %v", err)
	}
	thumbBounds := decodedThumb.Bounds()
	if thumbBounds.Dx() > DefaultMaxThumbDimension || thumbBounds.Dy() > DefaultMaxThumbDimension {
		t.Errorf("缩略图尺寸超标: %dx%d (最长边应 <= %d)",
			thumbBounds.Dx(), thumbBounds.Dy(), DefaultMaxThumbDimension)
	}
	// 验证等比性 (800/600 = 4/3 => 512 / 384)
	if thumbBounds.Dx() != 512 || thumbBounds.Dy() != 384 {
		t.Errorf("缩略图等比缩放计算不符: 实际 %dx%d (预期 512x384)",
			thumbBounds.Dx(), thumbBounds.Dy())
	}

	// 测试自定义等级: low (最长边 256px => 256x192)
	resLow, err := ProcessImage(testPngPath, ThumbPresets[ThumbLevelLow])
	if err != nil {
		t.Fatalf("ProcessImage(low) 执行失败: %v", err)
	}
	decLow, _ := jpeg.Decode(bytes.NewReader(resLow.ThumbData))
	if decLow.Bounds().Dx() != 256 || decLow.Bounds().Dy() != 192 {
		t.Errorf("low 等级缩略图尺寸不符: 实际 %dx%d (预期 256x192)",
			decLow.Bounds().Dx(), decLow.Bounds().Dy())
	}

	// 测试自定义等级: medium (最长边 384px => 384x288)
	resMed, err := ProcessImage(testPngPath, ThumbPresets[ThumbLevelMedium])
	if err != nil {
		t.Fatalf("ProcessImage(medium) 执行失败: %v", err)
	}
	decMed, _ := jpeg.Decode(bytes.NewReader(resMed.ThumbData))
	if decMed.Bounds().Dx() != 384 || decMed.Bounds().Dy() != 288 {
		t.Errorf("medium 等级缩略图尺寸不符: 实际 %dx%d (预期 384x288)",
			decMed.Bounds().Dx(), decMed.Bounds().Dy())
	}

	// 测试自定义等级: ultra (最长边 768px => 768x576)
	resUltra, err := ProcessImage(testPngPath, ThumbPresets[ThumbLevelUltra])
	if err != nil {
		t.Fatalf("ProcessImage(ultra) 执行失败: %v", err)
	}
	decUltra, _ := jpeg.Decode(bytes.NewReader(resUltra.ThumbData))
	if decUltra.Bounds().Dx() != 768 || decUltra.Bounds().Dy() != 576 {
		t.Errorf("ultra 等级缩略图尺寸不符: 实际 %dx%d (预期 768x576)",
			decUltra.Bounds().Dx(), decUltra.Bounds().Dy())
	}
}

// TestParseThumbLevel 验证各等级别名解析与回退机制
func TestParseThumbLevel(t *testing.T) {
	cases := []struct {
		input       string
		expectedDim int
		expectedQ   int
	}{
		{"", 512, 85},
		{"high", 512, 85},
		{"HIGH", 512, 85},
		{"3", 512, 85},
		{"高清", 512, 85},
		{"low", 256, 75},
		{"1", 256, 75},
		{"低", 256, 75},
		{"medium", 384, 80},
		{"2", 384, 80},
		{"中", 384, 80},
		{"ultra", 768, 90},
		{"4", 768, 90},
		{"超清", 768, 90},
		{"92", 512, 92},      // 自定义 quality
		{"invalid-xxx", 512, 85}, // 异常回退
	}

	for _, tc := range cases {
		cfg := ParseThumbLevel(tc.input)
		if cfg.MaxDimension != tc.expectedDim || cfg.Quality != tc.expectedQ {
			t.Errorf("ParseThumbLevel(%q) = (%d, %d), 预期 (%d, %d)",
				tc.input, cfg.MaxDimension, cfg.Quality, tc.expectedDim, tc.expectedQ)
		}
	}
}

// TestDecodeImageMismatchExtension 测试伪扩展名容错 (如真实内容为 JPEG 但扩展名为 .png)
func TestDecodeImageMismatchExtension(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "snapvault_mismatch_test_*")
	if err != nil {
		t.Fatalf("创建临时目录失败: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// 创建一张真实的 JPEG 图像
	jpegImg := image.NewRGBA(image.Rect(0, 0, 100, 100))
	for y := 0; y < 100; y++ {
		for x := 0; x < 100; x++ {
			jpegImg.Set(x, y, color.RGBA{R: 200, G: 100, B: 50, A: 255})
		}
	}

	// 伪装成 .png 扩展名
	fakePngPath := filepath.Join(tempDir, "single.png")
	outFile, err := os.Create(fakePngPath)
	if err != nil {
		t.Fatalf("创建伪扩展名测试文件失败: %v", err)
	}
	if err := jpeg.Encode(outFile, jpegImg, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatalf("编码 JPEG 失败: %v", err)
	}
	outFile.Close()

	// 使用 ProcessImage 进行处理，验证容错嗅探能够成功解码
	res, err := ProcessImage(fakePngPath)
	if err != nil {
		t.Fatalf("ProcessImage 应对伪扩展名图片自动容错嗅探，但报错了: %v", err)
	}
	if len(res.JpegData) == 0 || len(res.ThumbData) == 0 {
		t.Fatalf("伪扩展名图片转码与生成缩略图数据不应为空")
	}
}
