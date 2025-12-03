document.getElementById("signup-btn").addEventListener("click", async () => {

  const data = {
    full_name: document.getElementById("full-name").value.trim(),
    email: document.getElementById("email").value.trim(),
    phone: document.getElementById("phone").value.trim(),
    rank: document.getElementById("rank")?.value || null,
    va_disability: document.getElementById("va")?.value || null,
    yos: document.getElementById("yos").value,
    family: document.getElementById("family").value,
    base: document.getElementById("base").value,
    notes: document.getElementById("notes").value.trim(),
    mode: document.getElementById("mode-ad").classList.contains("mode-btn-active") ? "active" : "veteran"
  };

  // 1️⃣ Save identity locally for the verify page
  localStorage.setItem("realtysass.identity", JSON.stringify(data));

  // 2️⃣ Save profile into Supabase BEFORE verify page
  await fetch("/api/save-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }).catch(err => console.error("Save profile failed:", err));

  // 3️⃣ Redirect user to email verification
  window.location.href = "/verify";
});
