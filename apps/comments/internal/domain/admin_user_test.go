package domain

import "testing"

func TestAdminUserRoleValidation(t *testing.T) {
	testCases := []struct {
		name        string
		roles       []string
		serviceKey  string
		expectAdmin bool
		expectSuper bool
	}{
		{"service admin for matching service", []string{"admin-blog1", "user"}, "blog1", true, false},
		{"service admin for other service", []string{"admin-blog1", "user"}, "blog2", false, false},
		{"super admin", []string{"superadmin", "user"}, "blog1", true, true},
		{"super admin applies to all", []string{"superadmin"}, "anything", true, true},
		{"regular user", []string{"user", "member"}, "blog1", false, false},
		{"multiple service admin", []string{"admin-blog1", "admin-blog2"}, "blog1", true, false},
		{"no roles", []string{}, "blog1", false, false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			adminUser := AdminUser{UserId: "test", Roles: tc.roles}

			if got := adminUser.HasServiceAdminRole(tc.serviceKey); got != tc.expectAdmin {
				t.Fatalf("HasServiceAdminRole(%q) = %t, want %t", tc.serviceKey, got, tc.expectAdmin)
			}

			if got := adminUser.IsSuperAdmin(); got != tc.expectSuper {
				t.Fatalf("IsSuperAdmin() = %t, want %t", got, tc.expectSuper)
			}
		})
	}
}
