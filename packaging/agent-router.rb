# Homebrew formula — lives in the tap repo yp201/homebrew-tap as Formula/agent-router.rb
# Users: brew tap yp201/tap && brew install agent-router && agent-router install
class AgentRouter < Formula
  desc "Sticky multi-account router and cache doctor for Claude Code (desktop + CLI)"
  homepage "https://github.com/yp201/agent-router"
  url "https://github.com/yp201/agent-router/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "a632cc9d46104d7b225f957838ccb3b226973c0fce188549ad7ee3381ba07172"
  license "MIT"
  head "https://github.com/yp201/agent-router.git", branch: "main"

  depends_on "node" # Node 24+ (the router uses node:sqlite and runs .ts directly)

  def install
    libexec.install Dir["*"]
    # `agent-router` on PATH → the control script; node from Homebrew is first on PATH for it
    (bin/"agent-router").write_env_script libexec/"agent-router.sh", PATH: "#{formula_opt_bin("node")}:$PATH"
  end

  # `brew services start agent-router` = the launchd job (KeepAlive, log under brew's var/log)
  service do
    run [formula_opt_bin("node")/"node", opt_libexec/"router.ts"]
    keep_alive true
    working_dir opt_libexec
    log_path var/"log/agent-router.log"
    error_log_path var/"log/agent-router.log"
  end

  def caveats
    <<~EOS
      Start the router:      brew services start agent-router
      Desktop-app capture:   agent-router install   (local CA + hosts entry; asks for sudo; undo with `agent-router uninstall`)
      CLI only, no sudo:     add {"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4001"}} to ~/.claude/settings.json
      Console:               http://localhost:4001/router/
    EOS
  end

  test do
    assert_match "usage", shell_output("#{bin}/agent-router 2>&1", 2)
  end
end
