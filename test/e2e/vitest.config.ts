import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/e2e/e2e.test.ts"],
		// Network round-trips through Docker add latency; give each test room to breathe
		testTimeout: 30_000,
		hookTimeout: 60_000,
		reporters: ["verbose"],
		// Explicitly forward proxy URLs into the worker context.
		// The config file runs in the main process (where the Docker-injected env is
		// already visible), so reading it here and re-declaring it ensures the value
		// survives regardless of which worker pool vitest uses.
		env: {
			NGINX_URL: process.env.NGINX_URL ?? "http://localhost:8080",
			CADDY_URL: process.env.CADDY_URL ?? "http://localhost:8081",
			APACHE_URL: process.env.APACHE_URL ?? "http://localhost:8082",
		},
	},
});
