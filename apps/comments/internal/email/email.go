package email

import (
	"log/slog"
	"os"
)

var logger = slog.New(slog.NewTextHandler(os.Stdout, nil))
var maxEmailsToSend = 20

type AuthenticationCodeEmail struct {
	EmailAddress string
	Code         string
}

type EmailSender struct {
	emailChannel       chan AuthenticationCodeEmail
	NumberOfEmailsSent int
}

func NewEmailSender(emailSendingStrategy func(email AuthenticationCodeEmail)) *EmailSender {
	var emailSender = EmailSender{
		emailChannel:       make(chan AuthenticationCodeEmail, 100),
		NumberOfEmailsSent: 0,
	}
	go emailSender.startWorker(emailSendingStrategy)
	return &emailSender
}

func (emailSender *EmailSender) SendEmail(email AuthenticationCodeEmail) bool {
	if emailSender.NumberOfEmailsSent >= maxEmailsToSend {
		logger.Warn("Reached maximum number of emails to send, ignoring email to %s", "emailaddress", email.EmailAddress)
		return false
	}
	emailSender.emailChannel <- email
	return true
}

func (emailSender *EmailSender) startWorker(emailSendingStrategy func(email AuthenticationCodeEmail)) {
	for email := range emailSender.emailChannel {
		// TODO: send email
		emailSendingStrategy(email)
		emailSender.NumberOfEmailsSent += 1
	}
}
