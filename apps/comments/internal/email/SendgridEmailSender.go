package email

type SendgridEmailSender struct {
}

func NewSendgridEmailSender() *SendgridEmailSender {
	return &SendgridEmailSender{}
}

func (sender *SendgridEmailSender) SendgridEmailSenderStrategy(email AuthenticationCodeEmail) {
	// TODO: send email
	logger.Debug("(SENDGRID EMAIL SENDING STRATEGY) Sending email to %s with code %s", email.EmailAddress, email.Code)
}
