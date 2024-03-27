package lang

import (
	"testing"
)

func TestIfElse(t *testing.T) {
	// Test case 1: Condition is true
	result1 := IfElse(true, "true value", "false value")
	if result1 != "true value" {
		t.Errorf("IfElse(true, \"true value\", \"false value\") = %v; want \"true value\"", result1)
	}

	// Test case 2: Condition is false
	result2 := IfElse(false, "true value", "false value")
	if result2 != "false value" {
		t.Errorf("IfElse(false, \"true value\", \"false value\") = %v; want \"false value\"", result2)
	}

	// Test case 3: Condition is true with integer values
	result3 := IfElse(true, 1, 2)
	if result3 != 1 {
		t.Errorf("IfElse(true, 1, 2) = %v; want 1", result3)
	}

	// Test case 4: Condition is false with integer values
	result4 := IfElse(false, 1, 2)
	if result4 != 2 {
		t.Errorf("IfElse(false, 1, 2) = %v; want 2", result4)
	}
}
