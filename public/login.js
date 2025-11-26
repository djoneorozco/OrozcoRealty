// ===============================
//   LOGIN FRONT-END JS
// ===============================

document.getElementById("login-btn").addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value.trim();
  const msg = document.getElementById("login-msg");

  msg.textContent = "Logging in...";

  const res = await fetch("/.netlify/functions/auth-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();

  if (!res.ok) {
    msg.textContent = data.error || "Login failed.";
    msg.style.color = "#ff6b6b";
    return;
  }

  msg.textContent = "Success! Redirecting...";
  msg.style.color = "#8ef3c5";

  // Save token
  localStorage.setItem("orozco_token", data.token);

  // Redirect
  setTimeout(() => {
    window.location.href = "/dashboard";
  }, 800);
});
