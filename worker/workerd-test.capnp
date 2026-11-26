using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "auth-test", worker = (
      modules = [(name = "auth.mjs", esModule = embed ".generated/workerd-auth.mjs")],
      compatibilityDate = "2026-11-19",
      globalOutbound = "fixture",
      bindings = [
        (name = "OUTBOUND_FIXTURE", service = "fixture"),
        (name = "WORKER_ORIGIN", text = "https://packing-runtime.example.test"),
        (name = "APP_ORIGIN", text = "https://packing-pages.example.test"),
        (name = "ACCESS_TEAM_DOMAIN", text = "diagnostic-example.cloudflareaccess.com"),
        (name = "ACCESS_AUD", text = "offline-test-audience"),
        (name = "ALLOWED_EMAILS", text = "operator@example.test"),
        (name = "SESSION_SECRET", text = "synthetic-fixture-for-local-workerd-test-only"),
        (name = "EXTRACTION_ENABLED", text = "false"),
      ],
    )),
    (name = "fixture", worker = (
      modules = [(name = "outbound.mjs", esModule = embed "runtime-tests/outbound.mjs")],
      compatibilityDate = "2026-11-19",
      globalOutbound = "fixture",
    )),
  ],
);
