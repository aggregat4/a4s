package domain

import (
	"net/http"
	"testing"
)

func TestParseCommentStatus(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    CommentStatus
		wantErr bool
	}{
		{name: "pending", input: "pending-approval", want: CommentStatusPendingApproval},
		{name: "approved", input: "approved", want: CommentStatusApproved},
		{name: "rejected", input: "rejected", wantErr: true},
		{name: "invalid", input: "archived", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseCommentStatus(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q", tc.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("ParseCommentStatus(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

func TestSameSiteFromString(t *testing.T) {
	cases := []struct {
		input string
		want  http.SameSite
	}{
		{input: "lax", want: http.SameSiteLaxMode},
		{input: "strict", want: http.SameSiteStrictMode},
		{input: "none", want: http.SameSiteNoneMode},
		{input: "unknown", want: http.SameSiteDefaultMode},
	}

	for _, tc := range cases {
		if got := SameSiteFromString(tc.input); got != tc.want {
			t.Fatalf("SameSiteFromString(%q) = %v, want %v", tc.input, got, tc.want)
		}
	}
}

func TestUserValidity(t *testing.T) {
	if (User{}).IsValid() {
		t.Fatalf("expected zero user to be invalid")
	}
	if !(User{Id: 42}).IsValid() {
		t.Fatalf("expected user with id to be valid")
	}
}
