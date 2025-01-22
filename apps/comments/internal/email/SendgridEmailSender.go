package email

import (
	"fmt"

	"github.com/sendgrid/sendgrid-go"
	"github.com/sendgrid/sendgrid-go/helpers/mail"
)

type SendgridEmailSender struct {
	fromName    string
	fromAddress string
	subject     string
	apiKey      string
}

func NewSendgridEmailSender(fromName, fromAddress, subject, apiKey string) *SendgridEmailSender {
	return &SendgridEmailSender{
		fromName:    fromName,
		fromAddress: fromAddress,
		subject:     subject,
		apiKey:      apiKey,
	}
}

func (sender *SendgridEmailSender) SendgridEmailSenderStrategy(email AuthenticationCodeEmail) {
	from := mail.NewEmail(sender.fromName, sender.fromAddress)
	to := mail.NewEmail("", email.EmailAddress) // We don't know the user's name
	subject := sender.subject

	plainTextContent := fmt.Sprintf("Your authentication code is: %s\nThis code will expire in 15 minutes.", email.Code)
	htmlContent := fmt.Sprintf("<p>Your authentication code is: <strong>%s</strong></p><p>This code will expire in 15 minutes.</p>", email.Code)

	message := mail.NewSingleEmail(from, subject, to, plainTextContent, htmlContent)
	client := sendgrid.NewSendClient(sender.apiKey)

	response, err := client.Send(message)
	if err != nil {
		logger.Error("Failed to send authentication email", "error", err)
		return
	}

	if response.StatusCode >= 200 && response.StatusCode < 300 {
		logger.Debug("Successfully sent authentication email", "to", email.EmailAddress)
	} else {
		logger.Error("Failed to send authentication email",
			"status_code", response.StatusCode,
			"body", response.Body,
			"headers", response.Headers)
	}
}
