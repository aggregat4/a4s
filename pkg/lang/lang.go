package lang

import "errors"

func IfElse[T any](cond bool, vtrue, vfalse T) T {
	if cond {
		return vtrue
	}
	return vfalse
}

func AssertNotNil(value interface{}, message string) {
	if value == nil {
		panic(message)
	}
}

var ErrNotFound = errors.New("not found")
