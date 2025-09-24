package main

import (
	"aggregat4/go-commentservice/internal/domain"
	"aggregat4/go-commentservice/internal/repository"
	"aggregat4/go-commentservice/internal/server"
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aggregat4/go-baselib/crypto"
	"github.com/aggregat4/go-baselib/lang"
	"github.com/kirsle/configdir"
	"github.com/kkyr/fig"

	_ "github.com/mattn/go-sqlite3"
	"github.com/willibrandon/mtlog"
	"github.com/willibrandon/mtlog/core"
)

var logger = mtlog.New(
	mtlog.WithConsole(),
	mtlog.WithMinimumLevel(core.InformationLevel),
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
		logger.Fatal("Error initializing database {err}", err)
		os.Exit(1)
	}

	controller := server.Controller{
		Store:  &store,
		Config: config,
	}

	httpServer := server.RunServer(&controller)

	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, syscall.SIGINT, syscall.SIGTERM)

	sig := <-shutdownSignals
	logger.Info("Shutdown signal received {signal}", sig)
	signal.Stop(shutdownSignals)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("Graceful shutdown failed {err}", err)
		if closeErr := httpServer.Close(); closeErr != nil {
			logger.Error("HTTP server close failed {err}", closeErr)
		}
	} else {
		logger.Info("HTTP server shut down gracefully")
	}
}
