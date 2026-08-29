package main

import (
	"crypto/rand"
	"encoding/hex"
	"io"
)

func main() {
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		panic(err)
	}
	println(hex.EncodeToString(key))
}
