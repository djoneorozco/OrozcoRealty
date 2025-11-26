// ===============================
//   SIGNUP FRONT-END JS
// ===============================

document.getElementById("signup-btn").addEventListener("click", async () => {
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value.trim();
  const msg = document.getElementById("signup-msg");

  msg.textContent = "Creating your account...";

  const res = await fetch("/.netlify/functions/auth-signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();

  if (!res.ok) {
    msg.textContent = data.error || "Signup failed.";
    msg.style.color = "#ff6b6b";
    return;
  }

  msg.textContent = "Account created! Redirecting...";
  msg.style.color = "#8ef3c5";

  // Store JWT in localStorage
  localStorage.setItem("orozco_token", data.token);

  // Redirect to dashboard
  setTimeout(() => {
    window.location.href = "/dashboard";
  }, 800);
});
