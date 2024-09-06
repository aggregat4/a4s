package main

import (
	"aggregat4/go-commentservice/internal/repository"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/aggregat4/go-baselib/crypto"
)

func main() {
	// Define command-line flags
	dbPath := flag.String("db", "comments.sqlite", "Path to the SQLite database file")
	serviceKey := flag.String("servicekey", "", "Service key for the new service")
	serviceOrigin := flag.String("serviceorigin", "", "Origin URL for the new service")
	encryptionKey := flag.String("encryptionkey", "", "32-byte encryption key for AES-256")

	// Parse command-line flags
	flag.Parse()

	// Validate required flags
	if *serviceKey == "" || *serviceOrigin == "" || *encryptionKey == "" {
		fmt.Printf("Error: service key, origin, encryption key, and db path are required\n")
		fmt.Printf("Service key: %s\n", *serviceKey)
		fmt.Printf("Service origin: %s\n", *serviceOrigin)
		fmt.Printf("Encryption key: %s\n", *encryptionKey)
		fmt.Printf("DB path: %s\n", *dbPath)
		flag.Usage()
		os.Exit(1)
	}

	// Create cipher for encryption
	secretKey, err := hex.DecodeString(*encryptionKey)
	if err != nil {
		panic(err)
	}
	aesCipher, err := crypto.CreateAes256GcmAead(secretKey)
	if err != nil {
		panic(err)
	}

	// Initialize repository
	store := &repository.Store{
		Cipher: aesCipher,
	}

	// Initialize and verify database
	dbUrl := repository.CreateFileDbUrl(*dbPath)
	err = store.InitAndVerifyDb(dbUrl)
	if err != nil {
		log.Fatalf("Error initializing database: %v", err)
	}
	defer store.Close()

	// Create new service
	serviceId, err := store.CreateService(*serviceKey, *serviceOrigin)
	if err != nil {
		log.Fatalf("Error creating service: %v", err)
	}

	fmt.Printf("Service created successfully with ID: %d\n", serviceId)
	fmt.Printf("Service Key: %s\n", *serviceKey)
	fmt.Printf("Service Origin: %s\n", *serviceOrigin)
}
