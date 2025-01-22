package main

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/email"
	"aggregat4/go-commentservice/internal/repository"
	"aggregat4/go-commentservice/internal/server"
	"encoding/hex"
	"flag"
	"fmt"
	"log"

	"github.com/aggregat4/go-baselib/crypto"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/kirsle/configdir"
	"github.com/kkyr/fig"

	_ "github.com/mattn/go-sqlite3"
)

func main() {
	var configFileLocation string
	flag.StringVar(&configFileLocation, "configdir", "", "The location of the configuration file if you do not want to default to the standard location, the name of the file is always commentservice.json")
	flag.Parse()
	defaultConfigLocation := configdir.LocalConfig("commentservice")
	defaultConfigFilename := "commentservice.json"

	var config domain.Config
	err := fig.Load(
		&config,
		fig.File(defaultConfigFilename),
		fig.Dirs(lang.IfElse(configFileLocation == "", defaultConfigLocation, configFileLocation)),
		fig.UseEnv("COMMENTSERVICE"))

	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", config)

	secretKey, err := hex.DecodeString(config.EncryptionKey)
	if err != nil {
		panic(err)
	}
	aesCipher, err := crypto.CreateAes256GcmAead(secretKey)
	if err != nil {
		panic(err)
	}
	var store = repository.Store{
		Cipher: aesCipher,
	}
	defer store.Close()
	err = store.InitAndVerifyDb(repository.CreateFileDbUrl(config.DatabaseFilename))
	if err != nil {
		log.Fatalf("Error initializing database: %s", err)
	}
	sendGridEmailSender := email.NewSendgridEmailSender(
		config.EmailFromName,
		config.EmailFromAddress,
		config.EmailSubject,
		config.SendgridApiKey,
	)
	emailSender := email.NewEmailSender(sendGridEmailSender.SendgridEmailSenderStrategy)
	server.RunServer(
		server.Controller{
			Store:       &store,
			Config:      config,
			EmailSender: emailSender,
		},
	)
}
