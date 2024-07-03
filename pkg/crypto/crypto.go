package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"github.com/aggregat4/go-baselib/lang"
	"golang.org/x/crypto/argon2"
	"io"
	"os"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), 14)
	return string(bytes), err
}

func CheckPasswordHash(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

func ReadRSAPrivateKey(filename string) (*rsa.PrivateKey, error) {
	privateKeyFile, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	privateKey, err := jwt.ParseRSAPrivateKeyFromPEM(privateKeyFile)
	if err != nil {
		return nil, err
	}
	return privateKey, err
}

func ReadRSAPublicKey(filename string) (*rsa.PublicKey, error) {
	publicKeyFile, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	publicKey, err := jwt.ParseRSAPublicKeyFromPEM(publicKeyFile)
	if err != nil {
		return nil, err
	}
	return publicKey, nil
}

func RandomString(byteCount uint32) (string, error) {
	b, err := RandomBytes(byteCount)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func RandomBytes(byteCount uint32) ([]byte, error) {
	b := make([]byte, byteCount)
	_, err := rand.Read(b)
	if err != nil {
		return nil, err
	}
	return b, nil
}

func CreateAes256GcmAead(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("key must be 32 bytes long in order to function as AES-256")
	}

	// Create a new AES cipher block
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	// Create a new GCM cipher mode
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	return gcm, nil
}

func EncryptAes256(plaintext string, aead cipher.AEAD) ([]byte, error) {
	lang.AssertNotNil(aead, "Require a valid non-nil cipher to encrypt")
	// Generate a random nonce
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	// Encrypt the plaintext
	return aead.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

func DecryptAes256(ciphertextBytes []byte, aead cipher.AEAD) (string, error) {
	lang.AssertNotNil(aead, "Require a valid non-nil cipher to decrypt")
	// Extract the nonce from the ciphertext
	nonceSize := aead.NonceSize()
	if len(ciphertextBytes) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertextBytes := ciphertextBytes[:nonceSize], ciphertextBytes[nonceSize:]

	// Decrypt the ciphertext
	plaintext, err := aead.Open(nil, nonce, ciphertextBytes, nil)
	if err != nil {
		return "", err
	}

	return string(plaintext), nil
}

/*
Password Hashing

According to OWASP (as of June 2024), Argon2ID is state of the art for password hashing:
see https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

This implementation is based off https://www.alexedwards.net/blog/how-to-hash-and-verify-passwords-with-argon2-in-go
This uses https://pkg.go.dev/golang.org/x/crypto/argon2#IDKey to derive a hash from a password.
*/

type Argon2IDParams struct {
	memory      uint32
	iterations  uint32
	parallelism uint8
	saltLength  uint32
	keyLength   uint32
}

var passwordHashingArgon2IDParams = Argon2IDParams{
	memory:      64 * 1024,
	iterations:  2,
	parallelism: 4,
	saltLength:  16,
	keyLength:   32,
}

func CreatePasswordHashWithDefaultParams(password string) (encodedHash string, err error) {
	return CreatePasswordHash(password, &passwordHashingArgon2IDParams)
}

func CreatePasswordHash(password string, p *Argon2IDParams) (encodedHash string, err error) {
	salt, err := RandomBytes(p.saltLength)
	if err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, p.iterations, p.memory, p.parallelism, p.keyLength)
	b64Salt := base64.RawStdEncoding.EncodeToString(salt)
	b64Hash := base64.RawStdEncoding.EncodeToString(hash)
	encodedHash = fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.memory, p.iterations, p.parallelism, b64Salt, b64Hash)
	return encodedHash, nil
}
