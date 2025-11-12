import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, addDoc, collection, query, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- Global Variables ---
let db;
let auth;
let userId = null;
let focusChartInstance = null;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// --- DOM Elements ---
const timerDisplay = document.getElementById('timer-display');
const startStopButton = document.getElementById('start-stop-button');
const startStopIcon = document.getElementById('start-stop-icon');
const startStopText = document.getElementById('start-stop-text');
const logButton = document.getElementById('log-button');
const resetButton = document.getElementById('reset-button');
const resetText = document.getElementById('reset-text');
const activityInput = document.getElementById('activity-input');
const lastLogDisplay = document.getElementById('last-log-display');
const chartStatus = document.getElementById('chart-status');
const userIdDisplay = document.getElementById('user-id-display');

// --- Timer State ---
let timerInterval = null;
let startTime = 0;
let elapsedTime = 0;
let isRunning = false;

// --- Utility Functions ---

/** Converts milliseconds to a human-readable MM:SS.cc format. */
function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);

    const pad = (num) => num.toString().padStart(2, '0');
    return `${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

/** Displays the custom modal message. */
function showModal(title, message) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('app-modal').style.display = 'flex';
}

window.closeModal = function() {
    document.getElementById('app-modal').style.display = 'none';
}

// --- Timer UI State Management ---

function updateTimerControls() {
    // Reset Button changes label based on state
    resetText.textContent = isRunning ? 'LAP' : 'RESET';

    // Start/Stop Button state
    startStopButton.classList.remove('bg-start', 'hover:bg-start', 'shadow-start', 'bg-stop', 'hover:bg-stop', 'shadow-stop');

    if (isRunning) {
        startStopButton.classList.add('bg-stop', 'hover:bg-stop', 'shadow-stop');
        startStopIcon.setAttribute('data-lucide', 'square');
        startStopText.textContent = 'STOP';
        logButton.disabled = true;
    } else {
        startStopButton.classList.add('bg-start', 'hover:bg-start', 'shadow-start');
        startStopIcon.setAttribute('data-lucide', 'play');
        startStopText.textContent = 'START';
        logButton.disabled = (elapsedTime < 1000); // Only allow logging after 1 second
    }

    // Re-render icons after changing attributes
    lucide.createIcons();
}

// --- Timer Logic ---

/**
 * Updates the timer display every 10ms.
 */
function updateDisplay() {
    const now = Date.now();
    elapsedTime = now - startTime;
    timerDisplay.textContent = formatTime(elapsedTime);
}

window.toggleTimer = function() {
    if (isRunning) {
        // Stop timer
        isRunning = false;
        clearInterval(timerInterval);
        timerInterval = null;
    } else {
        // Start timer
        if (elapsedTime > 0 && startTime !== 0) {
            startTime = Date.now() - elapsedTime; // Resume
        } else {
            startTime = Date.now(); // New start
        }
        isRunning = true;
        timerInterval = setInterval(updateDisplay, 10);
    }
    updateTimerControls();
}

window.resetOrLapTimer = function() {
    if (isRunning) {
        // LAP functionality (logs the current split time)
        const activity = activityInput.value.trim() || 'Unspecified Lap';
        const durationMs = elapsedTime;
        logEntry(activity, durationMs, true); // Log as a Lap
    } else {
        // RESET functionality
        elapsedTime = 0;
        startTime = 0;
        timerDisplay.textContent = '00:00.00';
        updateTimerControls();
    }
}

// --- Logging and Firebase Logic ---

async function logEntry(activity, durationMs, isLap = false) {
    if (!userId) {
        showModal('Logging Error', 'App is still authenticating. Please wait a moment.');
        return;
    }

    const logEntry = {
        userId: userId,
        activity: activity,
        durationMs: durationMs,
        timestamp: Date.now(),
        isLap: isLap
    };

    try {
        const logCollection = collection(db, `artifacts/${appId}/users/${userId}/focus_logs`);
        await addDoc(logCollection, logEntry);

        const formattedDuration = formatTime(durationMs);

        showModal(
            isLap ? 'Lap Logged!' : 'Session Logged!',
            `${isLap ? 'Lap' : 'Session'} "${activity}" recorded: ${formattedDuration}.`
        );

        // For full session log, reset timer, but for lap, keep running
        if (!isLap) {
            elapsedTime = 0;
            startTime = 0;
            timerDisplay.textContent = '00:00.00';
            updateTimerControls(); // Re-check logging capability
        }

        // Update dashboard
        await fetchAndRenderDashboard();

    } catch (e) {
        console.error("Error adding document: ", e);
        showModal('Logging Failed', 'Could not save data to the database. Check console for details.');
    }
}

window.logData = function() {
    if (isRunning || elapsedTime < 1000 || !userId) {
        showModal('Logging Error', 'Timer must be stopped and run for at least 1 second to log data.');
        return;
    }

    const activity = activityInput.value.trim() || 'Unspecified Focus Session';
    logEntry(activity, elapsedTime, false);
}

// --- Dashboard Logic ---

async function fetchAndRenderDashboard() {
    if (!db || !userId) {
        chartStatus.textContent = "Authentication required to load dashboard.";
        return;
    }

    chartStatus.textContent = "Fetching logs and building chart...";
    console.log("[Firestore] Fetching logs for user:", userId);

    try {
        const logCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/focus_logs`);
        const querySnapshot = await getDocs(logCollectionRef);

        console.log(`[Firestore] Found ${querySnapshot.size} documents.`);

        let totalDurationByActivity = {};
        let latestLog = null;
        let logCount = 0;

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const activity = data.activity || 'Unspecified Activity';
            const duration = data.durationMs || 0;
            logCount++;

            // Aggregate total duration
            totalDurationByActivity[activity] = (totalDurationByActivity[activity] || 0) + duration;

            // Track latest log
            if (!latestLog || data.timestamp > latestLog.timestamp) {
                latestLog = data;
            }
        });

        renderChart(totalDurationByActivity, logCount);
        updateLastLogDisplay(latestLog);

    } catch (error) {
        console.error("[Firestore ERROR] Error fetching logs for dashboard: ", error);
        chartStatus.textContent = "Error loading dashboard data.";
    }
}

function renderChart(data, logCount) {
    const labels = Object.keys(data);
    // Convert milliseconds to hours for display on the chart
    const chartData = labels.map(label => (data[label] / (1000 * 60 * 60)).toFixed(2));

    if (focusChartInstance) {
        focusChartInstance.destroy();
    }

    const canvasElement = document.getElementById('focusChart');
    if (!canvasElement) {
        console.error("[Chart ERROR] Canvas element 'focusChart' not found.");
        return;
    }
    const ctx = canvasElement.getContext('2d');

    if (labels.length === 0) {
        chartStatus.textContent = `No focus sessions logged yet. Total logs: ${logCount}.`;
        return;
    }
    chartStatus.textContent = `Total Time Logged Per Activity (in Hours). Total logs: ${logCount}.`;

    // Dynamic colors for the bars to look better with the dark theme
    const chartBarColor = labels.map((_, index) => {
        const colors = ['#6366f1', '#3b82f6', '#10b981', '#f97316']; // Indigo, Blue, Emerald, Orange
        return colors[index % colors.length];
    });


    focusChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Time Logged (Hours)',
                data: chartData,
                backgroundColor: chartBarColor,
                borderColor: '#1e293b',
                borderWidth: 1,
                borderRadius: 8, // Rounded bars look modern
                hoverBackgroundColor: chartBarColor.map(c => `${c}B0`), // Slightly transparent on hover
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Hours', color: '#94a3b8' },
                    ticks: { color: '#e2e8f0' },
                    grid: { color: 'rgba(100, 116, 139, 0.3)' } /* Lighter grid lines for dark mode */
                },
                x: {
                    ticks: { color: '#e2e8f0' },
                    grid: { display: false }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#0f172a',
                    titleColor: '#6366f1',
                    bodyColor: '#e2e8f0',
                    borderColor: '#6366f1',
                    borderWidth: 1,
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) { label += ': '; }
                            label += context.parsed.y + ' hours';
                            return label;
                        }
                    }
                }
            },
            color: '#e2e8f0',
        }
    });
}

function updateLastLogDisplay(lastLog) {
    if (lastLog) {
        const formattedTime = formatTime(lastLog.durationMs);
        const date = new Date(lastLog.timestamp).toLocaleDateString(undefined, {
            hour: '2-digit', minute: '2-digit'
        });

        lastLogDisplay.innerHTML = `Last Logged: <b>${lastLog.activity}</b> for <b>${formattedTime}</b> on ${date}`;
    } else {
        lastLogDisplay.textContent = 'No logs yet. Start your first session!';
    }
}


// --- Initialization ---

const initFirebase = async () => {
    if (!Object.keys(firebaseConfig).length) {
        console.error("Firebase config is missing. Data logging will not work.");
        return;
    }
    try {
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);

        // Authenticate the user
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                userId = user.uid;
                userIdDisplay.textContent = userId;
                // Fetch the dashboard immediately after successful auth
                await fetchAndRenderDashboard();
            } else {
                // Attempt to sign in if not already authenticated
                if (initialAuthToken) {
                    await signInWithCustomToken(auth, initialAuthToken);
                } else {
                    await signInAnonymously(auth);
                }
            }
        });
    } catch (e) {
        console.error("Firebase initialization failed:", e);
        showModal('Initialization Failed', 'Database connection failed. Check console for details.');
    }
};

// Initialize on load
window.onload = function() {
    // Render Lucide icons
    lucide.createIcons();

    // Set initial control states
    updateTimerControls();

    initFirebase();
}