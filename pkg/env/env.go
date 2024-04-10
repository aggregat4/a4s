package env

import (
	"fmt"
	"os"
	"strconv"
)

func RequireStringFromEnv(s string) string {
	value := os.Getenv(s)
	if value == "" {
		panic(fmt.Errorf("env variable %s is required", s))
	}
	return value
}

func GetIntFromEnv(key string, defaultValue int) int {
	value := os.Getenv(key)
	if value == "" {
		return defaultValue
	}
	intValue, err := strconv.Atoi(value)
	if err != nil {
		panic(fmt.Errorf("error parsing env variable %s: %s", key, err))
	}
	return intValue
}

func GetStringFromEnv(key string, defaultValue string) string {
	value := os.Getenv(key)
	if value == "" {
		return defaultValue
	}
	return value
}
