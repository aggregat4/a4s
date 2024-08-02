package main

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/email"
	"aggregat4/go-commentservice/internal/repository"
	"aggregat4/go-commentservice/internal/server"
	"flag"
	"fmt"
	"github.com/aggregat4/go-baselib/crypto"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/kirsle/configdir"
	"github.com/kkyr/fig"
	"log"
)

func main() {
	var configFileLocation string
	flag.StringVar(&configFileLocation, "config", "", "The location of the configuration file if you do not want to default to the standard location")
	flag.Parse()
	defaultConfigLocation := configdir.LocalConfig("commentservice") + "/commentservice.json"

	var config domain.Config
	err := fig.Load(&config, fig.File(lang.IfElse(configFileLocation == "", defaultConfigLocation, configFileLocation)))
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", config)

	// TODO: read encryption key from environment and decode from HEX string (see main.go)

	aesCipher, err := crypto.CreateAes256GcmAead([]byte(config.EncryptionKey))
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
	sendGridEmailSender := email.NewSendgridEmailSender()
	emailSender := email.NewEmailSender(sendGridEmailSender.SendgridEmailSenderStrategy)
	server.RunServer(
		server.Controller{
			Store:       &store,
			Config:      config,
			EmailSender: emailSender,
		},
	)
}
