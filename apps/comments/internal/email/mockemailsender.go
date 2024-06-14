package email

type MockEmailSender struct {
	SentEmails []AuthenticationCodeEmail
}

func NewMockEmailSender() *MockEmailSender {
	mockEmailSender := MockEmailSender{}
	mockEmailSender.SentEmails = []AuthenticationCodeEmail{}
	return &mockEmailSender
}

func (sender *MockEmailSender) MockEmailSenderStrategy(email AuthenticationCodeEmail) {
	logger.Debug("MockEmailSenderStrategy: Sending email to %s with code %s", email.EmailAddress, email.Code)
	sender.SentEmails = append(sender.SentEmails, email)
}
