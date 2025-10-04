const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Hardcoded admin credentials for logging in as admin
const adminUsername = 'admin';
const adminPassword = 'password123';
let activeUserCount = 0; // Track the number of connected users

// In-memory storage for registered users (username, password, and role)
let users = [];  // In-memory user storage, for demo purposes

// Set up session management
app.use(session({
    secret: 'your-secret-key', // Change this key to something secret
    resave: false,
    saveUninitialized: true
}));

// Serve the login page, but automatically redirect if already logged in
app.get('/login', (req, res) => {
    if (req.session.loggedIn) {
        return res.redirect('/admin'); // Auto-redirect to admin if already logged in
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html')); // Show login page otherwise
});

// Serve the registration page
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Handle registration post request
app.post('/register', express.urlencoded({ extended: true }), (req, res) => {
    const { username, password, confirmPassword } = req.body;

    // Check if passwords match
    if (password !== confirmPassword) {
        return res.send('Passwords do not match!');
    }

    // Check if username already exists
    const existingUser = users.find(user => user.username === username);
    if (existingUser) {
        return res.send('Username already taken!');
    }

    // Store the user details (set role as 'user' by default)
    users.push({ username, password, role: 'user' });
    res.send('Registration successful! <a href="/login">Login here</a>');
});

// Handle login post request
app.post('/login', express.urlencoded({ extended: true }), (req, res) => {
    const { username, password } = req.body;

    // Check for admin credentials
    if (username === adminUsername && password === adminPassword) {
        req.session.loggedIn = true;
        req.session.role = 'admin'; // Set the role to 'admin' for logged-in admin
        return res.redirect('/admin');
    }

    // Check for registered user credentials
    const user = users.find(user => user.username === username && user.password === password);
    if (user) {
        req.session.loggedIn = true;
        req.session.role = user.role; // Set the user's role (either 'user' or 'admin')
        return res.redirect('/admin');
    }

    res.send('Invalid credentials');
});

// Serve the admin panel only if logged in
app.get('/admin', (req, res) => {
    if (!req.session.loggedIn) {
        return res.redirect('/login');  // Redirect to login if not logged in
    }

    if (req.session.role === 'admin') {
        // Only admins can see the full admin panel
        res.sendFile(path.join(__dirname, 'public', 'admin_panel.html'));
    } else {
        // Non-admins get redirected to a user dashboard or home page
        res.redirect('/dashboard');  // Redirect to user dashboard for regular users
    }
});

// Serve the user dashboard for regular users
app.get('/dashboard', (req, res) => {
    if (!req.session.loggedIn) {
        return res.redirect('/login');  // Redirect to login if not logged in
    }

    // Serve user dashboard page
    res.sendFile(path.join(__dirname, 'public', 'user_dashboard.html'));  // Assuming you have this file
});

// Handle logout route
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect('/admin');  // In case of error, stay on the admin page
        }
        res.redirect('/login');  // Redirect to login page after successful logout
    });
});

// Serve the frontend HTML page
app.use(express.static(path.join(__dirname, 'public')));

// Handle new user connections
io.on('connection', (socket) => {
    activeUserCount++;
    console.log('A user connected. Active users: ' + activeUserCount);

    // Emit the active user count to all connected clients
    io.emit('user_count', activeUserCount);

    // Listen for system information from clients
    socket.on('send_system_info', (data) => {
        console.log('System Info:', data);
    });

    // Handle user disconnections
    socket.on('disconnect', () => {
        activeUserCount--;
        console.log('A user disconnected. Active users: ' + activeUserCount);
        io.emit('user_count', activeUserCount);
    });
});

// Start the server
server.listen(3000, () => {
    console.log('Server is running on http://free.slcatehiteam.shop:3000/login');
});
