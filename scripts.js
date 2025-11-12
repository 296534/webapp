import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, addDoc, collection, query, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- Global Variables ---
let db;
let auth;
let userId = null;
let focusChartInstance = null; // Stores the Chart.js instance

// Placeholder for Firebase configuration and auth token (to be replaced by your actual values)
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
let timerInterval = null; // Stores the setInterval ID
let startTime = 0; // Timestamp when the timer started/resumed
let elapsedTime = 0; // Total time elapsed in milliseconds
let isRunning = false; // Is the timer currently running?

// --- Utility Functions ---

/**
 * Converts milliseconds to a human-readable MM:SS.cc format (Minutes:Seconds.Centiseconds).
 * @param {number} ms - The time in milliseconds.
 * @returns {string} Formatted time string.
 */
function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10); // Get centiseconds

    // Pad with leading zeros if necessary
    const pad = (num) => num.toString().padStart(2, '0');
    return `${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

/**
 * Displays a custom modal with a title and message.
 * Replaces the native alert() for better UI/UX.
 * @param {string} title - The title of the modal.
 * @param {string} message - The message content of the modal.
 */
function showModal(title, message) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('app-modal').style.display = 'flex'; // Show modal
}

/**
 * Hides the custom modal.
 * Made available globally for the modal's "OK" button.
 */
window.closeModal = function() {
    document.getElementById('app-modal').style.display = 'none';
}

// --- Timer UI State Management ---

/**
 * Updates the appearance and text of timer control buttons
 * based on the current timer state (running or stopped).
 */
function updateTimerControls() {
    // Change RESET button text to LAP if timer is running
    resetText.textContent = isRunning ? 'LAP' : 'RESET';

    // Remove existing state classes from start/stop button
    startStopButton.classList.remove('bg-start', 'hover:bg-start', 'shadow-start', 'bg-stop', 'hover:bg-stop', 'shadow-stop');

    if (isRunning) {
        // If running, show STOP state
        startStopButton.classList.add('bg-stop', 'hover:bg-stop', 'shadow-stop');
        startStopIcon.setAttribute('data-lucide', 'square'); // Stop icon
        startStopText.textContent = 'STOP';
        logButton.disabled = true; // Cannot log while running
    } else {
        // If stopped, show START state
        startStopButton.classList.add('bg-start', 'hover:bg-start', 'shadow-start');
        startStopIcon.setAttribute('data-lucide', 'play'); // Play icon
        startStopText.textContent = 'START';
        // Enable log button only if time has elapsed (at least 1 second)
        logButton.disabled = (elapsedTime < 1000);
    }

    // Re-render Lucide icons after changing their `data-lucide` attribute
    lucide.createIcons();
}

// --- Timer Logic ---

/**
 * Updates the timer display every 10ms when the timer is running.
 */
function updateDisplay() {
    const now = Date.now();
    elapsedTime = now - startTime;
    timerDisplay.textContent = formatTime(elapsedTime);
}

/**
 * Toggles the timer between start and stop states.
 * Made available globally for the START/STOP button.
 */
window.toggleTimer = function() {
    if (isRunning) {
        // Stop timer
        isRunning = false;
        clearInterval(timerInterval); // Stop the interval updates
        timerInterval = null;
    } else {
        // Start timer
        if (elapsedTime > 0 && startTime !== 0) {
            // Resume from a paused state
            startTime = Date.now() - elapsedTime;
        } else {
            // Start a brand new timer session
            startTime = Date.now();
        }
        isRunning = true;
        timerInterval = setInterval(updateDisplay, 10); // Update display every 10ms
    }
    updateTimerControls(); // Update button states
}

/**
 * Resets the timer or logs a lap, depending on whether the timer is running.
 * Made available globally for the RESET/LAP button.
 */
window.resetOrLapTimer = function() {
    if (isRunning) {
        // LAP functionality: Log the current elapsed time as a 'lap'
        const activity = activityInput.value.trim() || 'Unspecified Lap';
        const durationMs = elapsedTime;
        logEntry(activity, durationMs, true); // Log as a Lap, keep timer running
    } else {
        // RESET functionality: Clear the timer
        elapsedTime = 0;
        startTime = 0;
        timerDisplay.textContent = '00:00.00'; // Reset display
        updateTimerControls(); // Update button states
    }
}

// --- Logging and Firebase Logic ---

/**
 * Logs an activity entry to Firebase Firestore.
 * @param {string} activity - The name of the activity.
 * @param {number} durationMs - The duration of the activity in milliseconds.
 * @param {boolean} isLap - True if it's a lap, false if it's a full session log.
 */
async function logEntry(activity, durationMs, isLap = false) {
    if (!userId) {
        showModal('Logging Error', 'App is still authenticating. Please wait a moment.');
        return;
    }
    
    // Create the log entry object
    const logEntry = {
        userId: userId,
        activity: activity,
        durationMs: durationMs,
        timestamp: Date.now(), // Current time in milliseconds
        isLap: isLap
    };

    try {
        // Reference to the user's specific focus_logs collection
        const logCollection = collection(db, `artifacts/${appId}/users/${userId}/focus_logs`);
        await addDoc(logCollection, logEntry); // Add the document

        const formattedDuration = formatTime(durationMs);

        // Show success modal
        showModal(
            isLap ? 'Lap Logged!' : 'Session Logged!',
            `${isLap ? 'Lap' : 'Session'} "${activity}" recorded: ${formattedDuration}.`
        );

        // If it was a full session log, reset the timer for the next session
        if (!isLap) {
            elapsedTime = 0;
            startTime = 0;
            timerDisplay.textContent = '00:00.00';
            updateTimerControls(); // Re-check logging capability
        }
        
        // Refresh the dashboard to include the new log
        await fetchAndRenderDashboard();

    } catch (e) {
        console.error("Error adding document: ", e);
        showModal('Logging Failed', 'Could not save data to the database. Check console for details.');
    }
}

/**
 * Handles logging the current stopped timer's duration as a session.
 * Made available globally for the LOG button.
 */
window.logData = function() {
    // Prevent logging if timer is running, or if less than 1 second has elapsed, or if not authenticated
    if (isRunning || elapsedTime < 1000 || !userId) {
        showModal('Logging Error', 'Timer must be stopped and run for at least 1 second to log data.');
        return;
    }

    const activity = activityInput.value.trim() || 'Unspecified Focus Session'; // Use input value or default
    logEntry(activity, elapsedTime, false); // Log as a full session
}

// --- Dashboard Logic ---

/**
 * Fetches focus logs from Firestore and renders the dashboard chart.
 */
async function fetchAndRenderDashboard() {
    if (!db || !userId) {
        chartStatus.textContent = "Authentication required to load dashboard.";
        return;
    }

    chartStatus.textContent = "Fetching logs and building chart...";
    console.log("[Firestore] Fetching logs for user:", userId);

    try {
        // Query the user's focus_logs collection
        const logCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/focus_logs`);
        const querySnapshot = await getDocs(logCollectionRef);

        console.log(`[Firestore] Found ${querySnapshot.size} documents.`);

        let totalDurationByActivity = {}; // Aggregate duration per activity
        let latestLog = null; // Track the most recent log
        let logCount = 0; // Count total logs

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const activity = data.activity || 'Unspecified Activity';
            const duration = data.durationMs || 0;
            logCount++;

            // Aggregate total duration for each activity
            totalDurationByActivity[activity] = (totalDurationByActivity[activity] || 0) + duration;

            // Update latest log
            if (!latestLog || data.timestamp > latestLog.timestamp) {
                latestLog = data;
            }
        });

        renderChart(totalDurationByActivity, logCount); // Render the chart with aggregated data
        updateLastLogDisplay(latestLog); // Update the "Last Logged" display

    } catch (error) {
        console.error("[Firestore ERROR] Error fetching logs for dashboard: ", error);
        chartStatus.textContent = "Error loading dashboard data.";
    }
}

/**
 * Renders or updates the Chart.js bar chart with focus time data.
 * @param {object} data - An object where keys are activity names and values are total durations in milliseconds.
 * @param {number} logCount - Total number of individual log entries.
 */
function renderChart(data, logCount) {
    const labels = Object.keys(data);
    // Convert milliseconds to hours for display on the chart
    const chartData = labels.map(label => (data[label] / (1000 * 60 * 60)).toFixed(2));

    // Destroy existing chart instance to prevent memory leaks and re-render issues
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


    // Define a set of appealing colors for the chart bars in a dark theme
    const chartBarColor = labels.map((_, index) => {
        const colors = ['#6366f1', '#3b82f6', '#10b981', '#f97316', '#a855f7', '#ec4899']; // Indigo, Blue, Emerald, Orange, Purple, Pink
        return colors[index % colors.length]; // Cycle through colors
    });


    // Create a new Chart.js instance
    focusChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Time Logged (Hours)',
                data: chartData,
                backgroundColor: chartBarColor,
                borderColor: '#1e293b', // Dark border for bars
                borderWidth: 1,
                borderRadius: 8, // Rounded bars look modern
                hoverBackgroundColor: chartBarColor.map(c => `${c}B0`), // Slightly transparent on hover
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false, // Allows chart to fill its container
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Hours', color: '#94a3b8' }, // Axis title color
                    ticks: { color: '#e2e8f0' }, // Tick label color
                    grid: { color: 'rgba(100, 116, 139, 0.3)' } /* Lighter grid lines for dark mode */
                },
                x: {
                    ticks: { color: '#e2e8f0' },
                    grid: { display: false } // No vertical grid lines
                }
            },
            plugins: {
                legend: { display: false }, // Hide legend as there's only one dataset
                tooltip: {
                    backgroundColor: '#0f172a', // Dark tooltip background
                    titleColor: '#6366f1', // Indigo title color
                    bodyColor: '#e2e8f0', // Light body text color
                    borderColor: '#6366f1', // Indigo border
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
            color: '#e2e8f0', // Default text color for chart
        }
    });
}

/**
 * Updates the "Last Logged" text display in the footer.
 * @param {object|null} lastLog - The most recent log entry object, or null if none.
 */
function updateLastLogDisplay(lastLog) {
    if (lastLog) {
        const formattedTime = formatTime(lastLog.durationMs);
        const date = new Date(lastLog.timestamp).toLocaleDateString(undefined, {
            hour: '2-digit', minute: '2-digit' // Format date and time
        });

        lastLogDisplay.innerHTML = `Last Logged: <b>${lastLog.activity}</b> for <b>${formattedTime}</b> on ${date}`;
    } else {
        lastLogDisplay.textContent = 'No logs yet. Start your first session!';
    }
}


// --- Initialization ---

/**
 * Initializes Firebase, sets up authentication, and fetches initial dashboard data.
 */
const initFirebase = async () => {
    // Check if Firebase config is provided (important for deployed versions)
    if (!Object.keys(firebaseConfig).length) {
        console.error("Firebase config is missing. Data logging will not work.");
        showModal('Firebase Error', 'Firebase configuration is missing. Data cannot be saved.');
        return;
    }
    try {
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);

        // Listen for authentication state changes
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                // User is signed in
                userId = user.uid;
                userIdDisplay.textContent = userId; // Display user ID
                console.log("Firebase user authenticated:", userId);
                await fetchAndRenderDashboard(); // Load dashboard data for the authenticated user
            } else {
                // User is signed out, attempt to sign in
                userIdDisplay.textContent = 'Authenticating...';
                console.log("No Firebase user found. Attempting sign-in...");
                if (initialAuthToken) {
                    // Use custom token if provided (e.g., from an embedding platform)
                    await signInWithCustomToken(auth, initialAuthToken);
                } else {
                    // Sign in anonymously if no custom token (for quick demos/new users)
                    await signInAnonymously(auth);
                }
            }
        });
    } catch (e) {
        console.error("Firebase initialization failed:", e);
        showModal('Initialization Failed', 'Database connection failed. Check console for details.');
    }
};

// --- Execute on page load ---
window.onload = function() {
    // Render all Lucide icons on the page
    lucide.createIcons();
    
    // Set initial state for timer buttons
    updateTimerControls();

    // Initialize Firebase services
    initFirebase();
}