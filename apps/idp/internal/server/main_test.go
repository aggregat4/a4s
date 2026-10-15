package server

import (
	"os"
	"testing"

	"github.com/aggregat4/a4s/pkg/crypto"
	"golang.org/x/crypto/bcrypt"
)

func TestMain(m *testing.M) {
	crypto.PasswordHashCost = bcrypt.MinCost
	os.Exit(m.Run())
}
