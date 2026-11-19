document.addEventListener('DOMContentLoaded', () => {
    // Enable Lucide icons when the CDN is available.
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // Show / hide both password fields.
    document.querySelectorAll('.toggle-password').forEach((button) => {
        button.addEventListener('click', () => {
            const input = document.getElementById(button.getAttribute('data-target'));
            if (!input) return;

            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            button.innerHTML = isPassword
                ? '<i data-lucide="eye-off"></i>'
                : '<i data-lucide="eye"></i>';

            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }
        });
    });

    const registerForm = document.getElementById('registerForm');
    const formMessage = document.getElementById('formMessage');
    const submitButton = registerForm ? registerForm.querySelector('button[type="submit"]') : null;

    function showMessage(text, type) {
        if (!formMessage) return;
        formMessage.className = 'form-message';
        if (type) formMessage.classList.add(type);
        formMessage.textContent = text;
    }

    if (!registerForm) return;

    registerForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const fullName = document.getElementById('fullName').value.trim();
        const universityEmail = document.getElementById('universityEmail').value.trim();
        const password = document.getElementById('password').value;
        const confirmPassword = document.getElementById('confirmPassword').value;

        showMessage('', '');

        if (!fullName || !universityEmail || !password || !confirmPassword) {
            showMessage('Please fill in all required fields.', 'error');
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(universityEmail)) {
            showMessage('Please enter a valid university email address.', 'error');
            return;
        }
        if (password.length < 12 || password.length > 128) {
            showMessage('Password must be between 12 and 128 characters.', 'error');
            return;
        }
        if (password !== confirmPassword) {
            showMessage('Passwords do not match.', 'error');
            return;
        }

        if (submitButton) submitButton.disabled = true;
        showMessage('Creating your CampusX account...', '');

        try {
            const response = await fetch('/auth/register', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fullName, universityEmail, password, confirmPassword }),
            });

            let data = null;
            try {
                data = await response.json();
            } catch {
                throw new Error('The server returned an invalid response.');
            }

            if (!response.ok || data.status !== 'ok') {
                const message = data?.error?.message || 'Account creation failed. Please try again.';
                showMessage(message, 'error');
                return;
            }

            const loginName = data.user?.username || universityEmail;
            showMessage(`Account created. Signed in as ${loginName}. Redirecting...`, 'success');
            window.location.assign(data.redirectTo || '/dashboard');
        } catch (error) {
            showMessage(error?.message || 'Could not reach the server. Please try again.', 'error');
        } finally {
            if (submitButton) submitButton.disabled = false;
        }
    });
});
