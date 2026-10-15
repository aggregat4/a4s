package crypto

import (
	"os"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestMain(m *testing.M) {
	PasswordHashCost = bcrypt.MinCost
	os.Exit(m.Run())
}
