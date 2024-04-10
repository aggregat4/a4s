package env

import (
	"os"
	"testing"
)

func TestRequireStringFromEnv(t *testing.T) {
	// Test case: Valid environment variable
	os.Setenv("TEST_ENV_VAR", "test_value")
	defer os.Unsetenv("TEST_ENV_VAR")
	value := requireStringFromEnv("TEST_ENV_VAR")
	if value != "test_value" {
		t.Errorf("Expected 'test_value', got '%s'", value)
	}

	// Test case: Missing environment variable
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("Expected panic, but didn't get one")
		}
	}()
	_ = requireStringFromEnv("MISSING_ENV_VAR")
}

func TestGetIntFromEnv(t *testing.T) {
	// Test case: Valid environment variable
	os.Setenv("TEST_INT_ENV_VAR", "42")
	defer os.Unsetenv("TEST_INT_ENV_VAR")
	value := getIntFromEnv("TEST_INT_ENV_VAR", 0)
	if value != 42 {
		t.Errorf("Expected 42, got %d", value)
	}

	// Test case: Missing environment variable
	value = getIntFromEnv("MISSING_ENV_VAR", 10)
	if value != 10 {
		t.Errorf("Expected 10, got %d", value)
	}

	// Test case: Invalid environment variable value
	os.Setenv("TEST_INVALID_ENV_VAR", "invalid")
	defer os.Unsetenv("TEST_INVALID_ENV_VAR")
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("Expected panic, but didn't get one")
		}
	}()
	_ = getIntFromEnv("TEST_INVALID_ENV_VAR", 0)
}

func TestGetStringFromEnv(t *testing.T) {
	// Test case: Valid environment variable
	os.Setenv("TEST_STRING_ENV_VAR", "test_value")
	defer os.Unsetenv("TEST_STRING_ENV_VAR")
	value := getStringFromEnv("TEST_STRING_ENV_VAR", "")
	if value != "test_value" {
		t.Errorf("Expected 'test_value', got '%s'", value)
	}

	// Test case: Missing environment variable
	value = getStringFromEnv("MISSING_ENV_VAR", "default_value")
	if value != "default_value" {
		t.Errorf("Expected 'default_value', got '%s'", value)
	}
}
