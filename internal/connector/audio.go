package connector

import (
	"context"
	"fmt"
	silk "github.com/wdvxdr1123/go-silk"
	"os"
	"os/exec"
)

func silkToOgg(ctx context.Context, raw []byte) ([]byte, error) {
	pcm, err := silk.DecodeSilkBuffToPcm(raw, 24000)
	if err != nil {
		return nil, fmt.Errorf("decode WeChat SILK audio: %w", err)
	}
	dir, err := os.MkdirTemp("", "matrix-wechat-audio-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	input, output := dir+"/voice.pcm", dir+"/voice.ogg"
	if err = os.WriteFile(input, pcm, 0600); err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", input, "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", output)
	if data, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("convert WeChat voice: %w (%s)", err, data)
	}
	return os.ReadFile(output)
}
