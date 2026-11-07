//go:build windows

// AppBuilder.exe — launcher for the Capacitor Android Builder.
// It sits in <project> or <project>/android-builder/. It starts the builder (server.mjs, embedded here)
// with Node.js in the background and opens it in its own app window (Edge/Chrome --app mode).
// The background process terminates immediately when the window is closed.
package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

//go:embed server.mjs
var serverJS []byte

//go:embed index.html
var indexHTML []byte

// Publish scripts (copied from ../scripts by build.cmd/build.sh); extracted next to app/ so
// the server finds them at <PKG_ROOT>/scripts even when the project has no scripts folder.
//
//go:embed scripts/*.mjs
var scriptsFS embed.FS

// Dice favicon and font (copied from ../src/assets by build.cmd/build.sh).
//
//go:embed assets/*
var assetsFS embed.FS

var (
	user32      = syscall.NewLazyDLL("user32.dll")
	kernel32    = syscall.NewLazyDLL("kernel32.dll")
	messageBoxW = user32.NewProc("MessageBoxW")
	createMutex = kernel32.NewProc("CreateMutexW")
)

const title = "Android App Builder"

func msg(text string, isError bool) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	flags := uintptr(0x40) // MB_ICONINFORMATION
	if isError {
		flags = 0x10 // MB_ICONERROR
	}
	messageBoxW.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
}

func fail(text string) {
	msg(text, true)
	os.Exit(1)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func findNode() string {
	if p, err := exec.LookPath("node.exe"); err == nil {
		return p
	}
	cands := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "nodejs", "node.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "nodejs", "node.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "nodejs", "node.exe"),
		filepath.Join(os.Getenv("NVM_SYMLINK"), "node.exe"),
		filepath.Join(os.Getenv("APPDATA"), "nvm", "current", "node.exe"),
	}
	for _, c := range cands {
		if exists(c) {
			return c
		}
	}
	return ""
}

func findBrowser() string {
	pf, pf86, local := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")
	cands := []string{
		filepath.Join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(pf, "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
		filepath.Join(local, "Google", "Chrome", "Application", "chrome.exe"),
	}
	for _, c := range cands {
		if exists(c) {
			return c
		}
	}
	return ""
}

func freePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 5179
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func tail(path string, n int) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		s = "…" + s[len(s)-n:]
	}
	return s
}

func main() {
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	var root, dataDir string
	hasCap := func(d string) bool {
		return exists(filepath.Join(d, "capacitor.config.json")) || exists(filepath.Join(d, "capacitor.config.ts")) || exists(filepath.Join(d, "capacitor.config.js"))
	}
	if exists(filepath.Join(dir, "package.json")) && hasCap(dir) {
		root = dir
		dataDir = filepath.Join(root, "android-builder")
	} else if parent := filepath.Dir(dir); exists(filepath.Join(parent, "package.json")) && hasCap(parent) {
		root = parent
		dataDir = dir
	} else {
		fail("این برنامه باید داخل ریشهٔ پروژه یا داخل پوشهٔ android-builder باشد.\n\nپیدا نشد: capacitor.config (json یا ts)")
	}

	// Compute project-specific hash for mutex, browser profile, and log isolation
	cleanRoot := strings.ToLower(filepath.Clean(root))
	hPath := sha256.Sum256([]byte(cleanRoot))
	projHash := hex.EncodeToString(hPath[:6])

	// One window at a time per project
	mutexName := fmt.Sprintf("Local\\CapacitorAndroidBuilder_%s", projHash)
	name, _ := syscall.UTF16PtrFromString(mutexName)
	h, _, err := createMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h != 0 && err == syscall.Errno(183) { // ERROR_ALREADY_EXISTS
		msg("بیلدر اندروید برای این پروژه همین حالا باز است.", false)
		return
	}

	appDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "CapacitorBuilder")
	uiDir := filepath.Join(appDir, "app")
	if err := os.MkdirAll(uiDir, 0o755); err != nil {
		fail("ساخت پوشهٔ موقت ممکن نشد: " + err.Error())
	}
	_ = os.WriteFile(filepath.Join(uiDir, "server.mjs"), serverJS, 0o644)
	_ = os.WriteFile(filepath.Join(uiDir, "index.html"), indexHTML, 0o644)
	scriptsDir := filepath.Join(appDir, "scripts")
	_ = os.MkdirAll(scriptsDir, 0o755)
	if entries, err := scriptsFS.ReadDir("scripts"); err == nil {
		for _, e := range entries {
			if data, err := scriptsFS.ReadFile("scripts/" + e.Name()); err == nil {
				_ = os.WriteFile(filepath.Join(scriptsDir, e.Name()), data, 0o644)
			}
		}
	}

	assetsDir := filepath.Join(appDir, "src", "assets")
	_ = os.MkdirAll(assetsDir, 0o755)
	if entries, err := assetsFS.ReadDir("assets"); err == nil {
		for _, e := range entries {
			if data, err := assetsFS.ReadFile("assets/" + e.Name()); err == nil {
				_ = os.WriteFile(filepath.Join(assetsDir, e.Name()), data, 0o644)
			}
		}
	}

	node := findNode()
	if node == "" {
		fail("Node.js پیدا نشد.\nبرای بیلد پروژه Node.js لازم است؛ نصبش کن (nodejs.org) و دوباره اجرا کن.")
	}

	port := freePort()
	logPath := filepath.Join(appDir, fmt.Sprintf("server-%s.log", projHash))
	logFile, _ := os.Create(logPath)
	cmd := exec.Command(node, filepath.Join(uiDir, "server.mjs"))
	cmd.Dir = root
	path := filepath.Dir(node) + ";" + os.Getenv("PATH")
	cmd.Env = append(os.Environ(), "PATH="+path,
		"MB_ROOT="+root, "MB_DATA="+dataDir, "MB_UI="+uiDir, "MB_AUTOEXIT=1",
		fmt.Sprintf("PORT=%d", port))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	if err := cmd.Start(); err != nil {
		fail("اجرای Node.js ممکن نشد: " + err.Error())
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	// Wait until the server answers (it may move to the next port if this one got taken)
	url := ""
	deadline := time.Now().Add(20 * time.Second)
	for url == "" && time.Now().Before(deadline) {
		select {
		case <-exited:
			fail("بیلدر اجرا نشد:\n\n" + tail(logPath, 1500))
		default:
		}
		for p := port; p < port+3; p++ {
			u := fmt.Sprintf("http://localhost:%d", p)
			c := http.Client{Timeout: 700 * time.Millisecond}
			if r, err := c.Get(u + "/api/state"); err == nil {
				r.Body.Close()
				if r.StatusCode == 200 {
					url = u
					break
				}
			}
		}
		if url == "" {
			time.Sleep(250 * time.Millisecond)
		}
	}
	if url == "" {
		_ = cmd.Process.Kill()
		fail("بیلدر به موقع بالا نیامد:\n\n" + tail(logPath, 1500))
	}

	var browserCmd *exec.Cmd
	if b := findBrowser(); b != "" {
		profile := filepath.Join(appDir, "profiles", projHash)
		browserCmd = exec.Command(b, "--app="+url, "--user-data-dir="+profile, "--window-size=1420,920",
			"--no-first-run", "--no-default-browser-check", "--disable-features=Translate", "--lang=fa")
		if err := browserCmd.Start(); err != nil {
			browserCmd = nil
			exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		}
	} else {
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	}

	shutdownServer := func() {
		// Clean quit via API
		c := http.Client{Timeout: 600 * time.Millisecond}
		_, _ = c.Post(url+"/api/quit", "text/plain", nil)

		select {
		case <-exited:
			return
		case <-time.After(800 * time.Millisecond):
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
	}

	if browserCmd != nil {
		browserDone := make(chan error, 1)
		go func() { browserDone <- browserCmd.Wait() }()

		select {
		case <-browserDone:
			// Browser window was closed by the user - shut down immediately
			shutdownServer()
		case <-exited:
			// Server exited on its own
		}
	} else {
		// Default browser opened via rundll32; wait for server autoexit
		<-exited
	}
}
