document.addEventListener('DOMContentLoaded', () => {
    // 1. تفعيل أيقونات Lucide
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }


    // 3. رسم شارت درجات الحرارة (Chart.js)
    const chartCtx = document.getElementById('dashboardTrendChart');
    if (chartCtx) {
        const ctx = chartCtx.getContext('2d');

        const tempGradient = ctx.createLinearGradient(0, 0, 0, 160);
        tempGradient.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
        tempGradient.addColorStop(1, 'rgba(56, 189, 248, 0)');

        new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', 'Now (Live)'],
                datasets: [{
                    label: 'Temperature (°C)',
                    data: [23.1, 23.4, 24.5, 24.8, 24.0, 23.8, 24.6],
                    borderColor: '#38bdf8',
                    borderWidth: 2,
                    backgroundColor: tempGradient,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: '#38bdf8'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 9 } } },
                    y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 9 } } }
                }
            }
        });
    }
});
document.addEventListener('DOMContentLoaded', () => {
    // 1. تفعيل أيقونات Lucide
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // 3. التفاعل مع أزرار الفلترة في صفحة الأجهزة
    const tabPills = document.querySelectorAll('.tab-pill');
    tabPills.forEach(pill => {
        pill.addEventListener('click', () => {
            tabPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
        });
    });
});
document.addEventListener('DOMContentLoaded', () => {
    // 1. تفعيل أيقونات Lucide
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

document.addEventListener('DOMContentLoaded', () => {
    // 1. تفعيل أيقونات Lucide
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // 3. التفاعل مع زر تشغيل/إيقاف المروحة
    const fanBtn = document.querySelector('.fan-power-btn');
    if (fanBtn) {
        fanBtn.addEventListener('click', () => {
            fanBtn.classList.toggle('active');
            const fanIcon = fanBtn.querySelector('svg');
            if (fanBtn.classList.contains('active')) {
                if (fanIcon) fanIcon.classList.add('spin-icon');
            } else {
                if (fanIcon) fanIcon.classList.remove('spin-icon');
            }
        });
    }
});
// التفاعل عند تغيير المعمل من القائمة المنسدلة
const labSelect = document.getElementById('lab-select-dropdown');
const labTitleBanner = document.querySelector('.banner-title-group h2');

if (labSelect && labTitleBanner) {
    labSelect.addEventListener('change', (e) => {
        const selectedLabText = e.target.options[e.target.selectedIndex].text;
        
        // تحديث العنوان في البانر الرئيسي
        labTitleBanner.innerHTML = `${selectedLabText} Overview <span class="primary-zone-tag">Primary Zone</span>`;
        if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }
        });
    }
   }); 
   // التفاعل عند الضغط على زر تسجيل الدخول
const loginForm = document.getElementById('login-form');
if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault(); // منع إعادة تحميل الصفحة
        
        // الانتقال لصفحة index.html الرئيسية
        window.location.href = 'index.html';
    });
}
