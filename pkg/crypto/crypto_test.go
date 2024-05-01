package crypto

import (
	"crypto/rand"
	"testing"
)

func TestHashPassword(t *testing.T) {
	password := "password123"
	hash, err := HashPassword(password)
	if err != nil {
		t.Errorf("HashPassword returned an error: %v", err)
	}

	if len(hash) == 0 {
		t.Errorf("HashPassword returned an empty hash")
	}
}

func TestCheckPasswordHash(t *testing.T) {
	password := "password123"
	hash, _ := HashPassword(password)

	if !CheckPasswordHash(password, hash) {
		t.Errorf("CheckPasswordHash returned false for a valid password and hash")
	}

	if CheckPasswordHash("wrongpassword", hash) {
		t.Errorf("CheckPasswordHash returned true for an invalid password and valid hash")
	}
}

func TestCreateAes256GcmAead(t *testing.T) {
	validKey := make([]byte, 32)
	_, err := rand.Read(validKey)
	if err != nil {
		t.Fatalf("Failed to generate random key: %v", err)
	}

	aead, err := CreateAes256GcmAead(validKey)
	if err != nil {
		t.Errorf("CreateAes256GcmAead returned an error for a valid key: %v", err)
	}
	if aead == nil {
		t.Errorf("CreateAes256GcmAead returned a nil AEAD for a valid key")
	}

	invalidKey := make([]byte, 16)
	_, err = CreateAes256GcmAead(invalidKey)
	if err == nil {
		t.Errorf("CreateAes256GcmAead should return an error for an invalid key size")
	}
}

func TestEncryptDecryptAes256(t *testing.T) {
	plaintext := "Hello, World!"
	key := make([]byte, 32)
	_, err := rand.Read(key)
	if err != nil {
		t.Fatalf("Failed to generate random key: %v", err)
	}

	aead, err := CreateAes256GcmAead(key)
	if err != nil {
		t.Fatalf("Failed to create AEAD: %v", err)
	}

	ciphertext, err := EncryptAes256(plaintext, aead)
	if err != nil {
		t.Errorf("EncryptAes256 returned an error: %v", err)
	}
	if len(ciphertext) == 0 {
		t.Errorf("EncryptAes256 returned an empty ciphertext")
	}

	decryptedText, err := DecryptAes256(ciphertext, aead)
	if err != nil {
		t.Errorf("DecryptAes256 returned an error: %v", err)
	}
	if decryptedText != plaintext {
		t.Errorf("DecryptAes256 returned an incorrect plaintext. Expected: %s, Got: %s", plaintext, decryptedText)
	}

	invalidCiphertext := make([]byte, aead.NonceSize()-1)
	_, err = DecryptAes256(invalidCiphertext, aead)
	if err == nil {
		t.Errorf("DecryptAes256 should return an error for an invalid ciphertext")
	}
}
