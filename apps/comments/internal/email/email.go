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
	numberOfEmailsSent int
}

func NewEmailSender(emailSendingStrategy func(email AuthenticationCodeEmail)) *EmailSender {
	var emailSender = EmailSender{
		emailChannel:       make(chan AuthenticationCodeEmail, 100),
		numberOfEmailsSent: 0,
	}
	emailSender.startWorker(emailSendingStrategy)
	return &emailSender
}

func (emailSender *EmailSender) SendEmail(email AuthenticationCodeEmail) bool {
	if emailSender.numberOfEmailsSent >= maxEmailsToSend {
		logger.Warn("Reached maximum number of emails to send, ignoring email to %s", email.EmailAddress)
		return false
	}
	emailSender.emailChannel <- email
	return true
}

func (emailSender *EmailSender) startWorker(emailSendingStrategy func(email AuthenticationCodeEmail)) {
	for email := range emailSender.emailChannel {
		// TODO: send email
		emailSendingStrategy(email)
		emailSender.numberOfEmailsSent += 1
	}
}
