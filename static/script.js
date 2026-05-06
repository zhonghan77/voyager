/* =========================================
   1. UTILITY FUNCTIONS & HELPERS
   ========================================= */

// Debounce function for performance optimization
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Throttle function for scroll events
function throttle(func, limit) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// Check if user prefers reduced motion
function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* =========================================
   1.5 ROUTE CACHE MANAGER (UPDATED)
   ========================================= */

class RouteCache {
    constructor(maxSize = 200) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.hits = 0;
        this.misses = 0;
    }

    // MODIFIED: Include profile (transport mode) in the key
    getKey(from, to, profile) {
        return `${profile}|${from.lat.toFixed(4)},${from.lon.toFixed(4)}-${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
    }

    // MODIFIED: Accept profile
    get(from, to, profile) {
        const key = this.getKey(from, to, profile);
        // Note: Reverse key logic removed for simplicity as walking/driving routes can differ by direction (one-way streets)
        // const reverseKey = this.getKey(to, from, profile);

        const result = this.cache.get(key);

        if (result) {
            this.hits++;
        } else {
            this.misses++;
        }

        return result;
    }

    // MODIFIED: Accept profile
    set(from, to, profile, route) {
        const key = this.getKey(from, to, profile);

        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, {
            ...route,
            cachedAt: Date.now()
        });
    }

    clear() {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }

    getStats() {
        const total = this.hits + this.misses;
        const hitRate = total > 0 ? (this.hits / total * 100).toFixed(1) : 0;
        return {
            size: this.cache.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: `${hitRate}%`
        };
    }
}

/* =========================================
   2. TOAST NOTIFICATION SYSTEM
   ========================================= */

class ToastManager {
    constructor(containerId = 'toast-container') {
        this.container = document.getElementById(containerId) || this.createContainer();
    }

    createContainer() {
        const container = document.createElement('div');
        container.id = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'true');
        document.body.appendChild(container);
        return container;
    }

    show(message, type = 'info', duration = 3000) {
        const toast = this.createToast(message, type);
        this.container.appendChild(toast);

        // Announce to screen readers
        this.announceToScreenReader(message.replace(/<[^>]*>/g, '')); // Strip HTML for screen reader

        setTimeout(() => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    createToast(message, type) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', 'alert');

        const icon = this.getIcon(type);
        toast.innerHTML = `
            <i class="bi bi-${icon}" aria-hidden="true"></i>
            <span>${message}</span>
        `;

        return toast;
    }

    getIcon(type) {
        const icons = {
            success: 'check-circle-fill',
            error: 'exclamation-circle-fill',
            warning: 'exclamation-triangle-fill',
            info: 'info-circle-fill'
        };
        return icons[type] || icons.info;
    }

    announceToScreenReader(message) {
        const announcement = document.createElement('div');
        announcement.className = 'sr-only';
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        announcement.textContent = message;
        document.body.appendChild(announcement);
        setTimeout(() => announcement.remove(), 1000);
    }
}

// Initialize global toast manager
const toast = new ToastManager();

// Legacy function for backward compatibility
function showToast(message, type = 'info') {
    toast.show(message, type);
}

/* =========================================
   3. ERROR HANDLER
   ========================================= */

class ErrorHandler {
    static async handleAPIError(error, context = '') {
        console.error(`[Error] ${context}:`, error);

        let message = 'An unexpected error occurred';

        if (error.response) {
            const status = error.response.status;
            switch (status) {
                case 400:
                    message = 'Invalid request. Please check your input.';
                    break;
                case 401:
                    message = 'Please login to continue.';
                    setTimeout(() => {
                        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
                    }, 1500);
                    break;
                case 403:
                    message = 'You don\'t have permission to perform this action.';
                    break;
                case 404:
                    message = 'The requested resource was not found.';
                    break;
                case 500:
                    message = 'Server error. Please try again later.';
                    break;
                default:
                    message = `Error: ${error.response.statusText}`;
            }
        } else if (error.request) {
            message = 'Network error. Please check your connection.';
        } else if (error.message) {
            message = error.message;
        }

        toast.show(message, 'error', 5000);
    }

    static logError(error, context) {
        // Integrate with error tracking service
    }
}

/* =========================================
   4. LOCAL STORAGE MANAGER
   ========================================= */

class StorageManager {
    static set(key, value, expiryMinutes = null) {
        try {
            const item = {
                data: value,
                timestamp: new Date().getTime()
            };

            if (expiryMinutes) {
                item.expiry = expiryMinutes * 60 * 1000;
            }

            localStorage.setItem(key, JSON.stringify(item));
            return true;
        } catch (e) {
            console.error('Storage error:', e);
            return false;
        }
    }

    static get(key) {
        try {
            const itemStr = localStorage.getItem(key);
            if (!itemStr) return null;

            const item = JSON.parse(itemStr);

            // Check expiry
            if (item.expiry) {
                const now = new Date().getTime();
                if (now - item.timestamp > item.expiry) {
                    localStorage.removeItem(key);
                    return null;
                }
            }

            return item.data;
        } catch (e) {
            console.error('Storage error:', e);
            return null;
        }
    }

    static remove(key) {
        localStorage.removeItem(key);
    }

    static clear() {
        localStorage.clear();
    }
}

/* =========================================
   5. NAVIGATION ENHANCEMENT
   ========================================= */

class NavigationManager {
    constructor() {
        this.mobileMenuBtn = document.querySelector('.mobile-menu-btn');
        this.navLinks = document.querySelector('.nav-links');
        this.navbar = document.querySelector('.navbar');
        this.lastScrollTop = 0;

        this.init();
    }

    init() {
        this.setupMobileMenu();
        this.highlightActivePage();
        this.setupScrollBehavior();
        this.setupKeyboardNavigation();
    }

    setupMobileMenu() {
        if (!this.mobileMenuBtn || !this.navLinks) return;

        this.overlay = document.getElementById('mobile-menu-overlay');

        const toggleMenu = () => {
            const isActive = this.navLinks.classList.toggle('mobile-active');

            if (this.overlay) {
                this.overlay.classList.toggle('active', isActive);
            }

            const icon = this.mobileMenuBtn.querySelector('i');
            if (icon) {
                if (isActive) {
                    icon.style.transform = 'rotate(90deg)';
                    icon.classList.remove('bi-list');
                    icon.classList.add('bi-x');
                    icon.style.fontSize = '2.2rem';
                } else {
                    icon.style.transform = 'rotate(0deg)';
                    icon.classList.remove('bi-x');
                    icon.classList.add('bi-list');
                    icon.style.fontSize = '';
                }
            }

            this.mobileMenuBtn.setAttribute('aria-expanded', isActive);
            document.body.classList.toggle('mobile-menu-open', isActive);
        };

        this.mobileMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu();
        });

        if (this.overlay) {
            this.overlay.addEventListener('click', () => {
                if (this.navLinks.classList.contains('mobile-active')) {
                    toggleMenu();
                }
            });
        }

        this.navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                if (this.navLinks.classList.contains('mobile-active')) {
                    toggleMenu();
                }
            });
        });
    }

    highlightActivePage() {
        const currentPath = window.location.pathname;
        const navLinks = document.querySelectorAll('.nav-links a');

        navLinks.forEach(link => {
            link.classList.remove('active');
            const linkPath = new URL(link.href).pathname;

            if (linkPath === currentPath || (currentPath === '/' && linkPath === '/')) {
                link.classList.add('active');
            }
        });
    }

    setupScrollBehavior() {
        if (!this.navbar) return;

        const handleScroll = throttle(() => {
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

            if (scrollTop > this.lastScrollTop && scrollTop > 100) {
                // Scrolling down
                this.navbar.style.transform = 'translateY(-100%)';
            } else {
                // Scrolling up
                this.navbar.style.transform = 'translateY(0)';
            }

            // Add shadow on scroll
            if (scrollTop > 10) {
                this.navbar.classList.add('scrolled');
            } else {
                this.navbar.classList.remove('scrolled');
            }

            this.lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;
        }, 100);

        window.addEventListener('scroll', handleScroll, { passive: true });
    }

    setupKeyboardNavigation() {
        // Allow keyboard navigation for mobile menu
        if (this.mobileMenuBtn) {
            this.mobileMenuBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.mobileMenuBtn.click();
                }
            });
        }

        // Escape key to close mobile menu
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.navLinks?.classList.contains('mobile-active')) {
                this.navLinks.classList.remove('mobile-active');
                const icon = this.mobileMenuBtn?.querySelector('i');
                if (icon) {
                    icon.classList.add('bi-list');
                    icon.classList.remove('bi-x');
                }
                document.body.style.overflow = '';
            }
        });
    }
}

/* =========================================
   6. SCROLL REVEAL ANIMATIONS
   ========================================= */

class ScrollReveal {
    constructor() {
        this.init();
    }

    init() {
        if (prefersReducedMotion()) {
            // Skip animations for users who prefer reduced motion
            document.querySelectorAll('.reveal-on-scroll').forEach(el => {
                el.classList.add('active');
            });
            return;
        }

        this.markElementsForReveal();
        this.setupObserver();
    }

    markElementsForReveal() {
        // Target specific elements for reveal animations
        const selectors = [
            '.hero-content > *',
            '.section-header',
            '.route-card',
            '.feature-card',
            '.timeline-item',
            '.user-card',
            '.edit-profile-box',
            '.trip-item',
            '.form-container',
            '.grid-3 > *',
            '.grid-2 > *'
        ];

        selectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach((el, index) => {
                if (el.classList.contains('reveal-on-scroll')) return;

                el.classList.add('reveal-on-scroll');

                // Add blur effect for images and cards with images
                if (el.querySelector('img') || el.tagName === 'IMG' ||
                    el.classList.contains('card-image-wrapper')) {
                    el.classList.add('effect-blur-in');
                }

                // Stagger effect for grid items
                if (el.parentElement.classList.contains('grid-3') ||
                    el.parentElement.classList.contains('grid-2') ||
                    el.parentElement.classList.contains('trip-list')) {
                    const delay = (index % 5) * 100;
                    if (delay > 0) {
                        el.style.animationDelay = `${delay}ms`;
                    }
                }
            });
        });
    }

    setupObserver() {
        const options = {
            threshold: 0.15,
            rootMargin: "0px 0px -50px 0px"
        };

        const observer = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('active');
                    obs.unobserve(entry.target);
                }
            });
        }, options);

        document.querySelectorAll('.reveal-on-scroll').forEach(el => {
            observer.observe(el);
        });
    }
}

/* =========================================
   7. OPENROUTESERVICE API INTEGRATION
   ========================================= */

class OpenRouteServiceAPI {
    constructor() {
        this.baseUrl = 'https://api.openrouteservice.org';
        this.requestCount = 0;
        this.dailyLimit = 2000;
    }

    async getRoute(from, to, profile = 'driving-car') {
        if (this.requestCount >= this.dailyLimit) {
            console.warn('[API] Daily API limit reached');
            throw new Error('Daily API limit reached');
        }

        try {
            // Use backend proxy instead of direct OpenRouteService call
            // This avoids CORS issues, API key exposure, and connection problems from China
            const url = `/api/route?` +
                `from_lat=${from.lat}&` +
                `from_lon=${from.lon}&` +
                `to_lat=${to.lat}&` +
                `to_lon=${to.lon}&` +
                `profile=${profile}`;

            console.log(`[API] Calling route API (${profile})...`);
            const response = await fetch(url);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `API Error: ${response.status}`);
            }

            const data = await response.json();
            this.requestCount++;

            if (data.features && data.features.length > 0) {
                const route = data.features[0];
                const props = route.properties;
                const segment = props.segments[0];

                return {
                    coordinates: route.geometry.coordinates.map(
                        coord => [coord[1], coord[0]]
                    ),
                    distance: props.summary.distance / 1000,
                    duration: props.summary.duration / 60,
                    ascent: segment.ascent,
                    descent: segment.descent,
                    steps: segment.steps.map(step => ({
                        distance: (step.distance / 1000).toFixed(2) + ' km',
                        duration: (step.duration / 60).toFixed(1) + ' min',
                        instruction: step.instruction,
                        type: step.type
                    })),
                    provider: 'OpenRouteService',
                    profile: profile,
                    timestamp: Date.now()
                };
            }

            throw new Error('No route found');

        } catch (error) {
            console.error('[API] Route API error:', error);
            console.error('[API] OpenRouteService API error:', error);
            throw error;
        }
    }

    getRemainingRequests() {
        return this.dailyLimit - this.requestCount;
    }
}

/* =========================================
   9. ENHANCED TRIP PLANNER
   ========================================= */

class TripPlanner {
    constructor() {
        this.state = {
            map: null,
            markers: [],
            routes: [],
            polylines: [],
            days: [],
            currentEditingStop: null,
            tripName: 'My Road Trip',
            selectedRegion: 'world',
            transportMode: 'driving-car'
        };

        this.searchTimeout = null;
        this.sortableInstances = []; // Store Sortable instances for cleanup

        // Initialize Route Cache and OpenRouteService API
        this.routeCache = new RouteCache();
        this.orsAPI = new OpenRouteServiceAPI();

        // Verify we are on the planner page
        if (document.getElementById('map')) {
            this.init();
        }
    }

    init() {
        this.initMap();
        this.initEventListeners();
        this.loadSampleData();
        this.updateStats();

        // Expose functions for inline onclick handlers
        window.removeDay = (id) => this.removeDay(id);
        window.tripPlanner = this;
        window.editStop = (id) => this.editStop(id);
        window.removeStop = (id) => this.removeStop(id);
        window.handleViewModeChange = (e) => this.handleViewModeChange(e);
        this.setupModalControls();
    }

    // =========================================
    // MAP INITIALIZATION
    // =========================================
    initMap() {
        this.state.map = L.map('map').setView([20, 0], 2);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19
        }).addTo(this.state.map);

        this.state.map.on('click', (e) => {
            console.log('[Map] Clicked at:', e.latlng);
        });
    }

    // =========================================
    // EVENT LISTENERS
    // =========================================
    initEventListeners() {
        const regionSelect = document.getElementById('region-select');
        if (regionSelect) regionSelect.addEventListener('change', (e) => this.handleRegionChange(e));

        const addBtn = document.getElementById('add-btn');
        if (addBtn) addBtn.addEventListener('click', () => this.handleAddLocation());

        const locInput = document.getElementById('location-input');
        if (locInput) {
            locInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.handleAddLocation();
            });
            locInput.addEventListener('input', (e) => this.handleSearchInput(e));
        }

        const addDayBtn = document.getElementById('add-day-btn');
        if (addDayBtn) addDayBtn.addEventListener('click', () => this.addNewDay());

        const clearBtn = document.getElementById('clear-btn');
        if (clearBtn) clearBtn.addEventListener('click', () => this.clearAllStops());

        const optimizeBtn = document.getElementById('optimize-btn');
        if (optimizeBtn) optimizeBtn.addEventListener('click', () => this.optimizeRoute());

        const saveTripBtn = document.getElementById('save-trip-btn');
        if (saveTripBtn) saveTripBtn.addEventListener('click', () => this.saveTrip());

        const exportBtn = document.getElementById('export-btn');
        if (exportBtn) exportBtn.addEventListener('click', () => this.showExportModal());

        document.querySelectorAll('.view-mode-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleViewModeChange(e));
        });

        const sidebarToggle = document.getElementById('sidebar-toggle');
        if (sidebarToggle) sidebarToggle.addEventListener('click', () => this.toggleSidebar());

        // Setup POI panel collapse functionality
        this.setupPOIPanelCollapse();

        // MODIFIED: Add listeners for transport mode buttons
        document.querySelectorAll('.transport-mode-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleTransportModeChange(e));
        });
    }

    // =========================================
    // TRANSPORT MODE HANDLING
    // =========================================
    handleTransportModeChange(e) {
        // Get the button element (handle click on icon)
        const btn = e.target.closest('.transport-mode-btn');
        if (!btn) return;

        const mode = btn.dataset.mode;

        // If mode hasn't changed, do nothing
        if (this.state.transportMode === mode) return;

        // 1. Update State
        this.state.transportMode = mode;

        // 2. Update UI (Active Class)
        document.querySelectorAll('.transport-mode-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');

        // 3. Notify User
        const modeNames = {
            'driving-car': 'Driving',
            'cycling-regular': 'Cycling',
            'foot-walking': 'Walking'
        };
        toast.show(`Switched to ${modeNames[mode]} mode`, 'info');

        // 4. Recalculate Routes if there are stops
        if (this.state.days.some(day => day.stops.length > 1)) {
            this.calculateRoutes();
        }
    }

    // =========================================
    // REGION HANDLING
    // =========================================
    handleRegionChange(e) {
        const option = e.target.selectedOptions[0];
        const lat = parseFloat(option.dataset.lat);
        const lon = parseFloat(option.dataset.lon);
        const zoom = parseInt(option.dataset.zoom);

        this.state.selectedRegion = e.target.value;
        this.state.map.setView([lat, lon], zoom);

        toast.show(`Viewing ${option.text}`, 'info');
    }

    // =========================================
    // LOCATION SEARCH & ADD
    // =========================================
    handleSearchInput(e) {
        clearTimeout(this.searchTimeout);
        const query = e.target.value.trim();

        if (query.length < 2) {
            this.hideSuggestions();
            return;
        }

        this.searchTimeout = setTimeout(() => {
            this.searchLocations(query);
        }, 500);
    }


    // =========================================
    // MODIFIED: Search locations using Mapbox via backend proxy
    // =========================================
    async searchLocations(query) {
        try {
            // NEW: Use backend proxy API instead of direct Nominatim call
            // This avoids connection issues from China mainland
            const response = await fetch(
                `/api/geocode?q=${encodeURIComponent(query)}&limit=15`
            );

            // Check if request was successful
            if (!response.ok) {
                throw new Error('Search request failed');
            }

            const results = await response.json();

            // NOTE: Mapbox results are already sorted by relevance
            // No need for additional sorting logic
            this.displaySuggestions(results);
        } catch (error) {
            console.error('Search error:', error);
            toast.show('Search failed. Please try again.', 'error');
        }
    }

    // =========================================
    // Display suggestions - Updated for Mapbox compatibility
    // =========================================
    displaySuggestions(results) {
        const container = document.getElementById('search-suggestions');

        if (results.length === 0) {
            this.hideSuggestions();
            return;
        }

        const displayResults = results.slice(0, 5);

        container.innerHTML = displayResults.map(result => {
            // Extract location name
            const name = result.name || result.display_name.split(',')[0];

            // FIXED: Use display_name directly for Mapbox results (already well-formatted)
            // Mapbox returns: "London Eye, Westminster, London, Greater London, England, United Kingdom"
            const details = result.display_name || '';

            return `
            <div class="suggestion-item" data-lat="${result.lat}" data-lon="${result.lon}" data-name="${name}">
                <div class="suggestion-name">${name}</div>
                <div class="suggestion-details">${details}</div>
            </div>
            `;
        }).join('');

        container.classList.add('active');

        container.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                const lat = parseFloat(item.dataset.lat);
                const lon = parseFloat(item.dataset.lon);
                const name = item.dataset.name;

                this.addLocationToRoute(lat, lon, name);
                document.getElementById('location-input').value = '';
                this.hideSuggestions();
            });
        });
    }

    hideSuggestions() {
        const el = document.getElementById('search-suggestions');
        if (el) el.classList.remove('active');
    }

    handleAddLocation() {
        const input = document.getElementById('location-input');
        const query = input.value.trim();

        if (!query) {
            toast.show('Please enter a location', 'warning');
            return;
        }

        this.geocodeAndAdd(query);
    }

    // =========================================
    // Geocode and add location using Mapbox via backend proxy
    // =========================================
    async geocodeAndAdd(query) {
        try {
            this.showLoading();

            // NEW: Use backend proxy API instead of direct Nominatim call
            // This avoids connection issues from China mainland
            const response = await fetch(
                `/api/geocode?q=${encodeURIComponent(query)}&limit=10`
            );

            // Check if request was successful
            if (!response.ok) {
                throw new Error('Geocoding request failed');
            }

            const results = await response.json();

            this.hideLoading();

            if (results.length === 0) {
                toast.show('Location not found', 'error');
                return;
            }

            // Use the first result (Mapbox results are already sorted by relevance)
            const result = results[0];
            const name = result.name || result.display_name.split(',')[0];
            this.addLocationToRoute(parseFloat(result.lat), parseFloat(result.lon), name);

            document.getElementById('location-input').value = '';
        } catch (error) {
            this.hideLoading();
            console.error('Geocoding error:', error);
            toast.show('Error finding location', 'error');
        }
    }

    // =========================================
    // ROUTE MANAGEMENT
    // =========================================
    addLocationToRoute(lat, lon, name) {
        let activeDay = this.state.days.find(d => d.active);
        if (!activeDay) {
            activeDay = this.createDay(1);
            this.state.days.push(activeDay);
        }

        const stop = {
            id: Date.now(),
            name: name.split(',')[0],
            fullName: name,
            lat: lat,
            lon: lon,
            type: 'attraction',
            arrival: '',
            duration: 1,
            notes: '',
            budget: 0,
            dayId: activeDay.id
        };

        activeDay.stops.push(stop);
        this.addMarker(stop);
        this.calculateRoutes();
        this.renderDays();
        this.updateStats();
        this.autoSave();

        toast.show(`Added ${stop.name}`, 'success');
    }

    addMarker(stop, stopNumber = null, dayColor = '#1E3A8A') {
        // Create numbered marker icon
        const iconHtml = stopNumber
            ? `<div class="numbered-marker" style="background-color: ${dayColor};">
                 <span>${stopNumber}</span>
               </div>`
            : '';

        const markerOptions = stopNumber
            ? {
                icon: L.divIcon({
                    className: 'custom-numbered-marker',
                    html: iconHtml,
                    iconSize: [36, 36],
                    iconAnchor: [18, 18],
                    popupAnchor: [0, -20]
                }),
                title: stop.name
            }
            : { title: stop.name };

        const marker = L.marker([stop.lat, stop.lon], markerOptions).addTo(this.state.map);

        marker.bindPopup(`
            <strong>${stop.name}</strong><br>
            <small>${stop.fullName}</small>
        `);

        marker.stopId = stop.id;
        this.state.markers.push(marker);

        this.state.map.setView([stop.lat, stop.lon], Math.max(this.state.map.getZoom(), 10));
    }

    // =========================================
    // ENHANCED ROUTE CALCULATION WITH OPENROUTESERVICE
    // =========================================
    async calculateRoutes() {
        // Clear existing polylines
        this.state.polylines.forEach(line => this.state.map.removeLayer(line));
        this.state.polylines = [];

        // Clear existing markers
        this.state.markers.forEach(marker => this.state.map.removeLayer(marker));
        this.state.markers = [];

        for (const day of this.state.days) {
            const dayColor = this.getColorForDay(day.number);

            // Add numbered markers for each stop in this day
            day.stops.forEach((stop, index) => {
                this.addMarker(stop, index + 1, dayColor);
            });

            if (day.stops.length < 2) continue;

            for (let i = 0; i < day.stops.length - 1; i++) {
                const from = day.stops[i];
                const to = day.stops[i + 1];

                try {
                    const route = await this.getRouteWithCache(from, to);

                    if (route) {
                        to.routeFromPrevious = {
                            distance: route.distance,
                            duration: route.duration,
                            provider: route.provider
                        };

                        const polyline = L.polyline(route.coordinates, {
                            color: dayColor,
                            weight: 6,
                            opacity: 0.9,
                            lineCap: 'round',
                            lineJoin: 'round'
                        }).addTo(this.state.map);

                        this.state.polylines.push(polyline);
                    }
                } catch (error) {
                    console.error('Route calculation error:', error);
                }
            }
        }

        this.renderDays();
        this.updateStats();

        // Log cache stats
        const stats = this.routeCache.getStats();
        console.log('[Cache] Stats:', stats);
    }

    async getRouteWithCache(from, to) {
        const profile = this.state.transportMode; // Use current selected profile

        // Check cache first (using profile)
        const cached = this.routeCache.get(from, to, profile);
        if (cached) {
            console.log(`[Route] Using cached route for ${profile}`);
            return cached;
        }

        // Try OpenRouteService API first
        try {
            console.log(`[Route] Fetching new route from OpenRouteService (${profile})...`);
            const route = await this.orsAPI.getRoute(from, to, profile);

            if (route) {
                this.routeCache.set(from, to, profile, route);
                console.log(`[API] Remaining: ${this.orsAPI.getRemainingRequests()}`);
                return route;
            }
        } catch (error) {
            console.warn('OpenRouteService failed, falling back to OSRM:', error);
        }

        // Fallback to OSRM (Only if driving, or accept fallback inaccuracy for other modes)
        try {
            // Only use OSRM fallback for driving-car as OSRM public API is car-focused by default.
            // If you want to support others, you'd need the specific OSRM endpoints.
            // For now, let's limit reliable fallback to driving.
            if (profile === 'driving-car') {
                const route = await this.getRouteOSRM(from, to);
                if (route) {
                    this.routeCache.set(from, to, profile, route);
                    return route;
                }
            }
        } catch (error) {
            console.warn('OSRM also failed:', error);
        }

        // Last resort: straight line estimation (adjusted for mode)
        return this.getFallbackRoute(from, to);
    }

    async getRouteOSRM(from, to) {
        try {
            const response = await fetch(
                `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`
            );
            const data = await response.json();

            if (data.code === 'Ok' && data.routes.length > 0) {
                const route = data.routes[0];
                return {
                    coordinates: route.geometry.coordinates.map(coord => [coord[1], coord[0]]),
                    distance: route.distance / 1000,
                    duration: route.duration / 60,
                    provider: 'OSRM (backup)'
                };
            }
        } catch (error) {
            console.error('OSRM error:', error);
        }
        return null;
    }

    getFallbackRoute(from, to) {
        const distance = this.calculateDistance(from.lat, from.lon, to.lat, to.lon);
        const duration = this.estimateDrivingTime(distance, from, to);

        return {
            coordinates: [
                [from.lat, from.lon],
                [to.lat, to.lon]
            ],
            distance: distance,
            duration: duration,
            provider: 'Estimated'
        };
    }

    estimateDrivingTime(distance, from, to) {
        let avgSpeed = 80;
        const mode = this.state.transportMode;

        // Adjust average speed based on mode
        if (mode === 'cycling-regular') {
            avgSpeed = 15; // 15 km/h for cycling
        } else if (mode === 'foot-walking') {
            avgSpeed = 5;  // 5 km/h for walking
        } else {
            // Driving logic
            if (distance < 10) {
                avgSpeed = 40;
            } else if (distance < 50) {
                avgSpeed = 60;
            } else if (distance < 200) {
                avgSpeed = 80;
            } else {
                avgSpeed = 90;
            }
        }

        const baseTime = (distance / avgSpeed) * 60;
        // Less buffer for walking/cycling as traffic matters less
        const bufferPercent = mode === 'driving-car' ? (distance < 50 ? 0.2 : 0.1) : 0.05;
        const bufferTime = baseTime * bufferPercent;

        return Math.ceil(baseTime + bufferTime);
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;  // Earth's radius in kilometers
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    // =========================================
    // DAY MANAGEMENT
    // =========================================
    createDay(number) {
        return {
            id: Date.now(),
            number: number,
            name: `Day ${number}`,
            stops: [],
            active: true
        };
    }

    addNewDay() {
        const newDayNumber = this.state.days.length + 1;

        this.state.days.forEach(d => d.active = false);

        const newDay = this.createDay(newDayNumber);
        newDay.active = true;
        this.state.days.push(newDay);

        this.renderDays();

        this.autoSave();

        toast.show(`Day ${newDayNumber} added`, 'success');
    }

    removeDay(dayId) {
        const dayIndex = this.state.days.findIndex(d => d.id === dayId);
        if (dayIndex === -1) return;

        const day = this.state.days[dayIndex];

        if (!confirm(`Delete Day ${day.number} and all its stops?`)) return;

        day.stops.forEach(stop => {
            const marker = this.state.markers.find(m => m.stopId === stop.id);
            if (marker) {
                this.state.map.removeLayer(marker);
                this.state.markers = this.state.markers.filter(m => m !== marker);
            }
        });

        this.state.days.splice(dayIndex, 1);

        this.state.days.forEach((d, i) => {
            d.number = i + 1;
            d.name = `Day ${i + 1}`;
        });

        this.calculateRoutes();
        this.renderDays();
        this.updateStats();

        this.autoSave();

        toast.show('Day removed', 'success');
    }

    // =========================================
    // RENDERING
    // =========================================
    renderDays() {
        const container = document.getElementById('route-list');

        if (this.state.days.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="bi bi-map" aria-hidden="true"></i>
                    <p>Start building your route</p>
                    <small>Add destinations to see them here</small>
                </div>
            `;
            return;
        }

        container.innerHTML = this.state.days.map(day => this.renderDay(day)).join('');

        // Initialize Sortable for cross-day dragging
        this.initializeCrossDayDragging();

        const totalStops = this.state.days.reduce((sum, day) => sum + day.stops.length, 0);
        const countEl = document.getElementById('count');
        if (countEl) countEl.textContent = totalStops;
    }

    /**
     * Initialize cross-day dragging functionality
     * Allows dragging stops between different days
     */
    initializeCrossDayDragging() {
        if (typeof Sortable === 'undefined') {
            console.warn('[Planner] Sortable.js not loaded, drag functionality disabled');
            return;
        }

        // Destroy existing Sortable instances to avoid duplicates
        if (this.sortableInstances) {
            this.sortableInstances.forEach(instance => instance.destroy());
        }
        this.sortableInstances = [];

        this.state.days.forEach(day => {
            const stopsContainer = document.querySelector(`[data-day-id="${day.id}"] .day-stops`);

            if (stopsContainer) {
                const sortableInstance = Sortable.create(stopsContainer, {
                    group: 'shared-days', // Same group allows dragging between containers
                    animation: 200,
                    handle: '.stop-item',
                    ghostClass: 'stop-ghost',
                    dragClass: 'stop-dragging',
                    chosenClass: 'stop-chosen',

                    // Show visual feedback
                    onChoose: (evt) => {
                        console.log('[Drag] Started dragging stop');
                    },

                    // Handle the drop event
                    onEnd: (evt) => {
                        const stopId = parseInt(evt.item.dataset.stopId);
                        const fromDayId = parseInt(evt.from.closest('[data-day-id]').dataset.dayId);
                        const toDayId = parseInt(evt.to.closest('[data-day-id]').dataset.dayId);
                        const newIndex = evt.newIndex;
                        const oldIndex = evt.oldIndex;

                        console.log(`[Drag] Moving stop ${stopId} from day ${fromDayId} to day ${toDayId}`);

                        // Find source and destination days
                        const fromDay = this.state.days.find(d => d.id === fromDayId);
                        const toDay = this.state.days.find(d => d.id === toDayId);

                        if (!fromDay || !toDay) {
                            console.error('[Drag] Could not find days');
                            return;
                        }

                        // Same day - just reorder
                        if (fromDayId === toDayId) {
                            console.log('[Drag] Reordering within same day');
                            const [movedStop] = fromDay.stops.splice(oldIndex, 1);
                            fromDay.stops.splice(newIndex, 0, movedStop);
                        }
                        // Different day - move between days
                        else {
                            console.log('[Drag] Moving between different days');
                            // Remove from source day
                            const [movedStop] = fromDay.stops.splice(oldIndex, 1);
                            // Add to destination day
                            toDay.stops.splice(newIndex, 0, movedStop);

                            // Show feedback
                            if (typeof toast !== 'undefined') {
                                toast.show(`Moved "${movedStop.name}" from ${fromDay.name} to ${toDay.name}`, 'success');
                            }
                        }

                        // Recalculate routes and update UI
                        this.calculateRoutes();
                        this.renderDays();
                        this.updateStats();
                        this.autoSave();
                    }
                });

                this.sortableInstances.push(sortableInstance);
            }
        });
    }

    renderDay(day) {
        const totalDistance = day.stops.reduce((sum, stop) => {
            return sum + (stop.routeFromPrevious?.distance || 0);
        }, 0);

        const totalDuration = day.stops.reduce((sum, stop) => {
            return sum + (stop.routeFromPrevious?.duration || 0);
        }, 0);

        return `
            <div class="day-section" data-day-id="${day.id}">
                <div class="day-header" onclick="window.tripPlanner.setActiveDay(${day.id})" style="cursor: pointer;" title="Click to make this day active for adding new stops">
                    <div class="day-info">
                        <div class="day-title ${day.active ? 'active-day-indicator' : ''}">
                            <i class="bi bi-calendar-day"></i>
                            ${day.name}
                            ${day.active ? '<span class="badge-active">Active</span>' : ''}
                        </div>
                        <div class="day-stats">
                            <span class="day-stat">
                                <i class="bi bi-geo-alt"></i>
                                ${day.stops.length} stops
                            </span>
                            <span class="day-stat">
                                <i class="bi bi-speedometer2"></i>
                                ${totalDistance.toFixed(1)} km
                            </span>
                            <span class="day-stat">
                                <i class="bi bi-clock"></i>
                                ${this.formatDuration(totalDuration)}
                            </span>
                        </div>
                    </div>
                    <div class="day-actions">
                        <button class="btn-icon btn-icon-sm" onclick="removeDay(${day.id})" title="Delete day">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="day-stops">
                    ${day.stops.map((stop, index) => this.renderStop(stop, index + 1, day)).join('')}
                </div>
            </div>
        `;
    }

    renderStop(stop, number, day) {
        const typeIcons = {
            attraction: '<i class="bi bi-pin-map-fill"></i>',
            hotel: '<i class="bi bi-building"></i>',
            restaurant: '<i class="bi bi-cup-hot-fill"></i>',
            viewpoint: '<i class="bi bi-camera-fill"></i>',
            gas: '<i class="bi bi-fuel-pump-fill"></i>',
            other: '<i class="bi bi-geo-alt-fill"></i>'
        };

        const typeNames = {
            attraction: 'Attraction',
            hotel: 'Hotel',
            restaurant: 'Restaurant',
            viewpoint: 'Viewpoint',
            gas: 'Gas Station',
            other: 'Other'
        };

        const routeInfo = stop.routeFromPrevious ? `
            <div class="stop-route-info">
                <i class="bi bi-arrow-down"></i>
                ${stop.routeFromPrevious.distance.toFixed(1)} km • ${this.formatDuration(stop.routeFromPrevious.duration)} 
                ${stop.routeFromPrevious.provider ? `<small style="color: #475569;"> via ${stop.routeFromPrevious.provider}</small>` : ''}
            </div>
        ` : '';

        const notes = stop.notes ? `
            <div class="stop-notes">
                <i class="bi bi-sticky"></i> ${stop.notes}
            </div>
        ` : '';

        return `
            <div class="stop-item" data-stop-id="${stop.id}">
                <div class="stop-header">
                    <div class="stop-main">
                        <div>
                            <span class="stop-number">${number}</span>
                            <span class="stop-name">${stop.name}</span>
                        </div>
                        <span class="stop-type-badge">${typeIcons[stop.type]} ${typeNames[stop.type]}</span>
                    </div>
                    <div class="stop-actions">
                        <button class="btn-icon btn-icon-sm" onclick="editStop(${stop.id})" title="Edit stop">
                            <i class="bi bi-pencil"></i>
                        </button>
                        <button class="btn-icon btn-icon-sm" onclick="removeStop(${stop.id})" title="Remove stop">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="stop-details">
                    ${stop.arrival ? `<span class="stop-detail"><i class="bi bi-clock"></i> ${stop.arrival}</span>` : ''}
                    ${stop.duration ? `<span class="stop-detail"><i class="bi bi-hourglass"></i> ${stop.duration}h</span>` : ''}
                    ${stop.budget ? `<span class="stop-detail"><i class="bi bi-cash"></i> $${stop.budget}</span>` : ''}
                </div>
                ${routeInfo}
                ${notes}
            </div>
        `;
    }

    // =========================================
    // STOP EDITING
    // =========================================
    editStop(stopId) {
        const stop = this.findStopById(stopId);
        if (!stop) return;

        this.state.currentEditingStop = stop;

        document.getElementById('stop-name').value = stop.name;
        document.getElementById('stop-type').value = stop.type;
        document.getElementById('stop-arrival').value = stop.arrival || '';
        document.getElementById('stop-duration').value = stop.duration || 1;
        document.getElementById('stop-notes').value = stop.notes || '';
        document.getElementById('stop-budget').value = stop.budget || 0;

        this.openModal('stop-modal');
    }

    // =========================================
    // CONFIRM DIALOG UTILITY
    // =========================================
    showConfirmDialog(title, message, onConfirm) {
        const overlay = document.getElementById('confirm-dialog');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const cancelBtn = document.getElementById('confirm-cancel');
        const okBtn = document.getElementById('confirm-ok');

        if (!overlay) return;

        // Set content
        titleEl.textContent = title;
        messageEl.textContent = message;

        // Show dialog
        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');

        // Handle buttons
        const handleCancel = () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            cancelBtn.removeEventListener('click', handleCancel);
            okBtn.removeEventListener('click', handleOk);
        };

        const handleOk = () => {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
            cancelBtn.removeEventListener('click', handleCancel);
            okBtn.removeEventListener('click', handleOk);
            if (onConfirm) onConfirm();
        };

        cancelBtn.addEventListener('click', handleCancel);
        okBtn.addEventListener('click', handleOk);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                handleCancel();
            }
        });
    }

    removeStop(stopId) {
        const stop = this.findStopById(stopId);
        if (!stop) return;

        // Use custom confirmation dialog
        this.showConfirmDialog(
            'Remove Stop',
            `Are you sure you want to remove "${stop.name}" from your trip?`,
            () => {
                // On confirm
                for (const day of this.state.days) {
                    const index = day.stops.findIndex(s => s.id === stopId);
                    if (index !== -1) {
                        day.stops.splice(index, 1);
                        break;
                    }
                }

                const marker = this.state.markers.find(m => m.stopId === stopId);
                if (marker) {
                    this.state.map.removeLayer(marker);
                    this.state.markers = this.state.markers.filter(m => m !== marker);
                }

                this.removeFromPlan(stop.name);
                this.calculateRoutes();
                this.renderDays();
                this.updateStats();
                this.autoSave();

                toast.show('Stop removed', 'success');
            }
        );
    }

    removeFromPlan(stopName) {
        try {
            let planDestinations = [];

            // Get current plan
            if (typeof StorageManager !== 'undefined') {
                planDestinations = StorageManager.get('voyager_plan') || [];
            } else {
                const item = localStorage.getItem('voyager_plan');
                if (item) {
                    const parsed = JSON.parse(item);
                    planDestinations = parsed.data || [];
                }
            }

            // Remove the destination by name
            const originalLength = planDestinations.length;
            planDestinations = planDestinations.filter(dest => dest.name !== stopName);

            if (planDestinations.length < originalLength) {
                // Save updated plan
                if (typeof StorageManager !== 'undefined') {
                    StorageManager.set('voyager_plan', planDestinations);
                } else {
                    localStorage.setItem('voyager_plan', JSON.stringify({
                        data: planDestinations,
                        timestamp: Date.now()
                    }));
                }

                console.log(`[Planner] Removed "${stopName}" from voyager_plan`);
            }
        } catch (e) {
            console.error('[Planner] Failed to remove from voyager_plan:', e);
        }
    }

    findStopById(stopId) {
        for (const day of this.state.days) {
            const stop = day.stops.find(s => s.id === stopId);
            if (stop) return stop;
        }
        return null;
    }

    // =========================================
    // MODAL CONTROLS
    // =========================================
    setupModalControls() {
        const cancelStop = document.getElementById('cancel-stop');
        if (cancelStop) cancelStop.addEventListener('click', () => {
            this.closeModal('stop-modal');
        });

        const saveStop = document.getElementById('save-stop');
        if (saveStop) saveStop.addEventListener('click', () => this.saveStopDetails());

        document.querySelectorAll('.export-option').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const format = e.currentTarget.dataset.format;
                this.handleExport(format);
            });
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                this.closeModal(e.target.closest('.modal').id);
            });
        });

        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.closeModal(e.target.closest('.modal').id);
            });
        });
    }

    saveStopDetails() {
        if (!this.state.currentEditingStop) return;

        const stop = this.state.currentEditingStop;
        stop.name = document.getElementById('stop-name').value;
        stop.type = document.getElementById('stop-type').value;
        stop.arrival = document.getElementById('stop-arrival').value;
        stop.duration = parseFloat(document.getElementById('stop-duration').value);
        stop.notes = document.getElementById('stop-notes').value;
        stop.budget = parseFloat(document.getElementById('stop-budget').value) || 0;

        const marker = this.state.markers.find(m => m.stopId === stop.id);
        if (marker) {
            marker.setPopupContent(`
                <strong>${stop.name}</strong><br>
                <small>${stop.fullName}</small>
            `);
        }

        this.renderDays();
        this.updateStats();
        this.closeModal('stop-modal');
        this.autoSave();

        toast.show('Stop updated', 'success');
    }

    openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('active');
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
            modal.setAttribute('aria-hidden', 'true');
            this.state.currentEditingStop = null;
        }
    }

    // =========================================
    // STATISTICS
    // =========================================
    updateStats() {
        const totalStops = this.state.days.reduce((sum, day) => sum + day.stops.length, 0);

        let totalDistance = 0;
        let totalDuration = 0;

        this.state.days.forEach(day => {
            day.stops.forEach(stop => {
                if (stop.routeFromPrevious) {
                    totalDistance += stop.routeFromPrevious.distance;
                    totalDuration += stop.routeFromPrevious.duration;
                }
            });
        });

        const totalStopsEl = document.getElementById('total-stops');
        if (totalStopsEl) totalStopsEl.textContent = totalStops;

        const totalDistEl = document.getElementById('total-distance');
        if (totalDistEl) totalDistEl.textContent = `${totalDistance.toFixed(1)} km`;

        const totalDurEl = document.getElementById('total-duration');
        if (totalDurEl) totalDurEl.textContent = this.formatDuration(totalDuration);

        const totalDaysEl = document.getElementById('total-days');
        if (totalDaysEl) totalDaysEl.textContent = this.state.days.length;
    }

    formatDuration(minutes) {
        const hours = Math.floor(minutes / 60);
        const mins = Math.round(minutes % 60);
        return `${hours}h ${mins}m`;
    }

    // =========================================
    // ENHANCED ROUTE OPTIMIZATION (2-OPT ALGORITHM)
    // =========================================
    async optimizeRoute() {
        if (this.state.days.length === 0) {
            toast.show('Add some locations first', 'warning');
            return;
        }

        this.showLoading();

        let totalImprovement = 0;

        for (const day of this.state.days) {
            if (day.stops.length < 3) continue;

            const beforeDistance = this.getTotalDistance(day.stops);
            day.stops = await this.optimize2Opt(day.stops);
            const afterDistance = this.getTotalDistance(day.stops);

            totalImprovement += beforeDistance - afterDistance;
        }

        await this.calculateRoutes();

        this.hideLoading();

        if (totalImprovement > 0) {
            toast.show(`Route optimized! Saved ${totalImprovement.toFixed(1)} km`, 'success');
        } else {
            toast.show('Route optimized!', 'success');
        }
    }

    async optimize2Opt(stops) {
        if (stops.length < 3) return stops;

        const first = stops[0];
        const last = stops[stops.length - 1];
        let middle = stops.slice(1, -1);

        middle = this.nearestNeighbor([first, ...middle, last]).slice(1, -1);

        let improved = true;
        let iterations = 0;
        const maxIterations = 50;

        while (improved && iterations < maxIterations) {
            improved = false;
            iterations++;

            for (let i = 0; i < middle.length - 1; i++) {
                for (let j = i + 1; j < middle.length; j++) {
                    const currentDistance = this.getTotalDistance([first, ...middle, last]);

                    const newRoute = [...middle];
                    const reversed = newRoute.slice(i, j + 1).reverse();
                    newRoute.splice(i, j - i + 1, ...reversed);

                    const newDistance = this.getTotalDistance([first, ...newRoute, last]);

                    if (newDistance < currentDistance - 0.1) {
                        middle = newRoute;
                        improved = true;
                        break;
                    }
                }
                if (improved) break;
            }
        }

        console.log(`[Optimization] 2-opt completed in ${iterations} iterations`);
        return [first, ...middle, last];
    }

    nearestNeighbor(stops) {
        if (stops.length < 3) return stops;

        const result = [stops[0]];
        const remaining = stops.slice(1);

        while (remaining.length > 0) {
            const last = result[result.length - 1];
            let nearestIndex = 0;
            let minDist = Infinity;

            remaining.forEach((stop, i) => {
                const dist = this.calculateDistance(last.lat, last.lon, stop.lat, stop.lon);
                if (dist < minDist) {
                    minDist = dist;
                    nearestIndex = i;
                }
            });

            result.push(remaining[nearestIndex]);
            remaining.splice(nearestIndex, 1);
        }

        return result;
    }

    getTotalDistance(stops) {
        let total = 0;
        for (let i = 0; i < stops.length - 1; i++) {
            total += this.calculateDistance(
                stops[i].lat, stops[i].lon,
                stops[i + 1].lat, stops[i + 1].lon
            );
        }
        return total;
    }

    // =========================================
    // ACTIONS
    // =========================================
    clearAllStops() {
        if (!confirm('Clear all stops and start over?')) return;

        this.state.markers.forEach(marker => this.state.map.removeLayer(marker));
        this.state.markers = [];

        this.state.polylines.forEach(line => this.state.map.removeLayer(line));
        this.state.polylines = [];

        this.state.days = [];
        this.routeCache.clear();

        this.renderDays();
        this.updateStats();

        toast.show('All stops cleared', 'info');
    }

    async saveTrip() {
        const tripData = {
            name: this.state.tripName,
            days: this.state.days,
            region: this.state.selectedRegion
        };

        localStorage.setItem('voyager_trip', JSON.stringify({
            ...tripData,
            created: new Date().toISOString()
        }));

        try {
            const response = await fetch('/api/save_trip', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(tripData)
            });

            if (response.status === 401) {
                toast.show('Please login to save your trip to the cloud.', 'warning');
                return;
            }

            if (!response.ok) throw new Error('Server error');

            const result = await response.json();
            toast.show('Trip saved to your Profile successfully!', 'success');

        } catch (error) {
            console.error('Save failed:', error);
            toast.show('Saved locally, but failed to sync to cloud.', 'warning');
        }
    }

    showExportModal() {
        if (this.state.days.length === 0) {
            toast.show('Add some locations first', 'warning');
            return;
        }

        this.openModal('export-modal');
    }

    handleExport(format) {
        this.closeModal('export-modal');

        switch (format) {
            case 'pdf':
                this.exportToPDF();
                break;
            case 'json':
                this.exportToJSON();
                break;
            case 'calendar':
                this.exportToCalendar();
                break;
            case 'share':
                this.shareTrip();
                break;
        }
    }

    exportToJSON() {
        const data = {
            name: this.state.tripName,
            days: this.state.days,
            totalStops: this.state.days.reduce((sum, day) => sum + day.stops.length, 0),
            created: new Date().toISOString()
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.state.tripName.replace(/\s+/g, '-')}.json`;
        a.click();

        toast.show('JSON exported!', 'success');
    }

    exportToPDF() {
        if (!window.jspdf) {
            toast.show('PDF library not loaded', 'error');
            return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        let yPos = 20;

        // Title
        doc.setFontSize(22);
        doc.setTextColor(212, 163, 115); // Primary color
        doc.text(this.state.tripName, 20, yPos);

        yPos += 10;
        doc.setFontSize(12);
        doc.setTextColor(100);
        doc.text(`Region: ${this.state.selectedRegion.toUpperCase()}`, 20, yPos);
        yPos += 20;

        // Iterate days
        this.state.days.forEach((day, index) => {
            if (yPos > 270) {
                doc.addPage();
                yPos = 20;
            }

            doc.setFontSize(16);
            doc.setTextColor(0);
            doc.text(`Day ${day.number}: ${day.stops.length} Stops`, 20, yPos);
            yPos += 10;

            day.stops.forEach((stop, stopIndex) => {
                if (yPos > 280) {
                    doc.addPage();
                    yPos = 20;
                }

                doc.setFillColor(212, 163, 115);
                doc.circle(25, yPos - 1, 1.5, 'F');

                doc.setFontSize(12);
                doc.setTextColor(0);
                doc.text(`${stopIndex + 1}. ${stop.name}`, 32, yPos);

                doc.setFontSize(10);
                doc.setTextColor(120);
                const detailText = `${stop.type.toUpperCase()} • ${stop.duration}h duration`;
                doc.text(detailText, 32, yPos + 5);

                if (stop.notes) {
                    doc.setFontSize(9);
                    doc.setTextColor(100);
                    const splitNotes = doc.splitTextToSize(`Note: ${stop.notes}`, 150);
                    doc.text(splitNotes, 32, yPos + 10);
                    yPos += (splitNotes.length * 4);
                }

                yPos += 15;
            });

            yPos += 10;
        });

        doc.save(`${this.state.tripName.replace(/\s+/g, '_')}.pdf`);
        toast.show('PDF downloaded!', 'success');
    }

    exportToCalendar() {
        let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Voyager//Trip Planner//EN\n";

        const startDate = new Date();
        startDate.setDate(startDate.getDate() + 1);
        startDate.setHours(9, 0, 0, 0);

        this.state.days.forEach((day, dayIndex) => {
            let currentDayDate = new Date(startDate);
            currentDayDate.setDate(startDate.getDate() + dayIndex);

            let currentTime = new Date(currentDayDate);

            day.stops.forEach(stop => {
                const startTime = this.formatICSDate(currentTime);

                currentTime.setMinutes(currentTime.getMinutes() + (stop.duration * 60));
                const endTime = this.formatICSDate(currentTime);

                currentTime.setMinutes(currentTime.getMinutes() + 30);

                icsContent += "BEGIN:VEVENT\n";
                icsContent += `SUMMARY:${stop.name} (${stop.type})\n`;
                icsContent += `DTSTART:${startTime}\n`;
                icsContent += `DTEND:${endTime}\n`;
                icsContent += `DESCRIPTION:${stop.notes || 'Visit via Voyager App'}\n`;
                icsContent += `LOCATION:${stop.name}\n`;
                icsContent += "END:VEVENT\n";
            });
        });

        icsContent += "END:VCALENDAR";

        const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.state.tripName.replace(/\s+/g, '_')}.ics`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        toast.show('Calendar (.ics) file exported!', 'success');
    }

    formatICSDate(date) {
        return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    }

    shareTrip() {
        const url = window.location.href;
        navigator.clipboard.writeText(url).then(() => {
            toast.show('Link copied to clipboard!', 'success');
        }).catch(() => {
            toast.show('Failed to copy link', 'error');
        });
    }

    // =========================================
    // VIEW MODE
    // =========================================
    handleViewModeChange(e) {
        const btn = e.target.closest('.view-mode-btn');
        if (!btn) return;
        const mode = btn.dataset.view;

        document.querySelectorAll('.view-mode-btn').forEach(b => {
            b.classList.remove('active');
        });
        btn.classList.add('active');

        if (mode === 'list') {
            document.getElementById('list-view').classList.remove('hidden');
            document.getElementById('timeline-view').classList.add('hidden');
        } else {
            document.getElementById('list-view').classList.add('hidden');
            document.getElementById('timeline-view').classList.remove('hidden');
            this.renderTimeline();
        }
    }

    renderTimeline() {
        const container = document.getElementById('timeline-content');

        const items = [];
        this.state.days.forEach(day => {
            day.stops.forEach(stop => {
                items.push({
                    day: day.number,
                    stop: stop
                });
            });
        });

        container.innerHTML = items.map(item => `
            <div class="timeline-item">
                <div class="timeline-marker"></div>
                <div class="timeline-content">
                    <div class="timeline-time">Day ${item.day}${item.stop.arrival ? ` • ${item.stop.arrival}` : ''}</div>
                    <strong>${item.stop.name}</strong>
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem;">
                        ${item.stop.duration}h visit
                        ${item.stop.notes ? `<br>${item.stop.notes}` : ''}
                    </div>
                </div>
            </div>
        `).join('');
    }

    // =========================================
    // UI UTILITIES
    // =========================================
    toggleSidebar() {
        const sidebar = document.querySelector('.planner-sidebar');
        sidebar.classList.toggle('collapsed');

        const icon = document.querySelector('#sidebar-toggle i');
        if (icon) {
            icon.classList.toggle('bi-chevron-right');
            icon.classList.toggle('bi-chevron-left');
        }

        setTimeout(() => {
            if (this.state.map) {
                this.state.map.invalidateSize();
            }
        }, 300);
    }

    // =========================================
    // POI PANEL COLLAPSE
    // =========================================
    setupPOIPanelCollapse() {
        document.querySelectorAll('.control-panel-header').forEach(header => {
            header.addEventListener('click', () => {
                const panel = header.closest('.map-control-panel');
                if (panel) {
                    panel.classList.toggle('collapsed');
                }
            });
        });
    }

    showLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.classList.add('active');
    }

    hideLoading() {
        const el = document.getElementById('loading-overlay');
        if (el) el.classList.remove('active');
    }

    getColorForDay(dayNumber) {
        const palette = [
            '#1d4ed8', // Day 1: Royal Blue (darker)
            '#6d28d9', // Day 2: Violet (darker)
            '#047857', // Day 3: Emerald (darker)
            '#b45309', // Day 4: Amber (darker)
            '#be185d', // Day 5: Pink (darker)
            '#4338ca'  // Day 6: Indigo (darker)
        ];

        return palette[(dayNumber - 1) % palette.length];
    }

    // =========================================
    // SAMPLE DATA (for demo)
    // =========================================

    setActiveDay(dayId) {
        this.state.days.forEach(d => d.active = false);

        // Set specified daysas active
        const day = this.state.days.find(d => d.id === dayId);
        if (day) {
            day.active = true;
            this.renderDays();
            this.autoSave();
            toast.show(`Day ${day.number} is now active for adding stops`, 'info');
        }
    }

    autoSave() {
        const tripData = {
            name: this.state.tripName,
            days: this.state.days,
            region: this.state.selectedRegion,
            transportMode: this.state.transportMode
        };

        localStorage.setItem('voyager_trip', JSON.stringify({
            ...tripData,
            created: new Date().toISOString(),
            autoSaved: true
        }));

        console.log('[AutoSave] Trip data saved to localStorage');
    }


    loadSampleData() {
        // First, check if there's a saved trip
        const saved = localStorage.getItem('voyager_trip');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                this.state.tripName = data.name;
                this.state.days = data.days;
                this.state.selectedRegion = data.region;

                // calculateRoutes will handle adding numbered markers
                this.calculateRoutes();
                this.renderDays();
                this.updateStats();

                toast.show('Trip loaded', 'success');
            } catch (e) {
                console.error('Failed to load trip:', e);
            }
        }

        // ALWAYS check for destinations added via "Add to Plan"
        // This allows adding new destinations even if a trip is already loaded
        this.loadPlanDestinations();
    }

    /**
     * Load destinations from voyager_plan (added via "Add to Plan" button)
     * and add them to the first day of the trip
     */
    loadPlanDestinations() {
        console.log('[Planner] ========== loadPlanDestinations START ==========');
        let planDestinations = [];

        // Get data from StorageManager or localStorage
        if (typeof StorageManager !== 'undefined') {
            console.log('[Planner] Using StorageManager');
            planDestinations = StorageManager.get('voyager_plan') || [];
        } else {
            console.log('[Planner] Using localStorage directly');
            const item = localStorage.getItem('voyager_plan');
            console.log('[Planner] localStorage raw item:', item);
            if (item) {
                try {
                    const parsed = JSON.parse(item);
                    planDestinations = parsed.data || [];
                    console.log('[Planner] Parsed destinations:', planDestinations);
                } catch (e) {
                    console.error('[Planner] Failed to parse plan destinations:', e);
                }
            }
        }

        console.log('[Planner] Total destinations found:', planDestinations ? planDestinations.length : 0);

        // If there are destinations in the plan, add them to the trip
        if (planDestinations && planDestinations.length > 0) {
            console.log(`[Planner] Loading ${planDestinations.length} destinations from plan`);

            // Create Day 1 if it doesn't exist
            if (this.state.days.length === 0) {
                console.log('[Planner] No days exist, creating Day 1');
                this.addNewDay();
            } else {
                console.log('[Planner] Days already exist:', this.state.days.length);
            }

            // Get the first day
            const firstDay = this.state.days[0];
            console.log('[Planner] First day object:', firstDay);
            console.log('[Planner] Current stops in Day 1:', firstDay.stops.length);

            // Check if destinations already exist to avoid duplicates
            const existingNames = new Set(firstDay.stops.map(s => s.name));
            console.log('[Planner] Existing stop names:', Array.from(existingNames));

            // Add each destination as a stop
            let addedCount = 0;
            planDestinations.forEach((dest, index) => {
                // Skip if already exists
                if (existingNames.has(dest.name)) {
                    console.log(`[Planner] Skipping duplicate: ${dest.name}`);
                    return;
                }

                const stop = {
                    id: Date.now() + index,
                    name: dest.name || 'Unnamed Stop',
                    fullName: dest.name || 'Unnamed Stop',
                    lat: parseFloat(dest.lat),
                    lon: parseFloat(dest.lon),
                    type: 'attraction',
                    arrival: '',
                    duration: 1,
                    notes: '',
                    budget: 0
                };

                console.log(`[Planner] Adding stop #${addedCount + 1}:`, stop);
                firstDay.stops.push(stop);
                addedCount++;
            });

            console.log('[Planner] Total stops added:', addedCount);
            console.log('[Planner] Day 1 stops after adding:', firstDay.stops);

            if (addedCount > 0) {
                // Recalculate routes and update UI
                console.log('[Planner] Recalculating routes...');
                this.calculateRoutes();

                console.log('[Planner] Rendering days...');
                this.renderDays();

                console.log('[Planner] Updating stats...');
                this.updateStats();

                // Show success message
                console.log('[Planner] Showing success toast');
                if (typeof toast !== 'undefined') {
                    toast.show(`<i class="bi bi-check-circle"></i> Loaded ${addedCount} destination(s) from your plan`, 'success');
                } else {
                    console.warn('[Planner] Toast object not available');
                }

                // Mark destinations as loaded (don't delete immediately)
                console.log('[Planner] Marking destinations as loaded');
                if (typeof StorageManager !== 'undefined') {
                    StorageManager.set('voyager_plan_loaded', true);
                } else {
                    localStorage.setItem('voyager_plan_loaded', 'true');
                }
            } else {
                console.log('[Planner] No new destinations to add (all were duplicates)');
            }
        } else {
            console.log('[Planner] No destinations to load from voyager_plan');
        }

        console.log('[Planner] ========== loadPlanDestinations END ==========');
    }
}

/* =========================================
   10. DESTINATIONS MANAGER (Add to Plan)
   ========================================= */
class DestinationsManager {
    constructor() {
        this.planKey = 'voyager_plan';
        // Only initialize if the Add to Plan button exists on the page
        if (document.querySelector('.js-add-to-plan')) {
            this.init();
        }
    }

    init() {
        this.setupPlanButtons();
        // Check button state (whether added) on page load
        this.updatePlanButtonsState();
    }

    // Read data from localStorage and update button appearance
    updatePlanButtonsState() {
        // Use StorageManager to get data, fall back to localStorage if undefined
        let currentPlan = [];
        if (typeof StorageManager !== 'undefined') {
            currentPlan = StorageManager.get(this.planKey) || [];
        } else {
            const item = localStorage.getItem(this.planKey);
            currentPlan = item ? JSON.parse(item).data : [];
        }

        // Create a Set of names for faster lookup
        const planNames = new Set(currentPlan.map(item => item.name));

        document.querySelectorAll('.js-add-to-plan').forEach(btn => {
            const name = btn.dataset.name;
            if (planNames.has(name)) {
                this.setButtonState(btn, true);
            } else {
                this.setButtonState(btn, false);
            }
        });
    }

    setupPlanButtons() {
        const buttons = document.querySelectorAll('.js-add-to-plan');

        buttons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.togglePlan(btn);
            });
        });
    }

    togglePlan(button) {
        const name = button.dataset.name;
        const lat = parseFloat(button.dataset.lat);
        const lon = parseFloat(button.dataset.lon);
        const id = button.dataset.id; // Better to use ID if available

        // Get current plan
        let currentPlan = [];
        if (typeof StorageManager !== 'undefined') {
            currentPlan = StorageManager.get(this.planKey) || [];
        } else {
            const item = localStorage.getItem(this.planKey);
            currentPlan = item ? JSON.parse(item).data : [];
        }

        // Check if destination exists in plan
        const existingIndex = currentPlan.findIndex(loc => loc.name === name);

        if (existingIndex !== -1) {
            // --- Remove Logic ---
            currentPlan.splice(existingIndex, 1);

            // Save updates
            if (typeof StorageManager !== 'undefined') {
                StorageManager.set(this.planKey, currentPlan);
            } else {
                localStorage.setItem(this.planKey, JSON.stringify({ data: currentPlan, timestamp: Date.now() }));
            }

            this.setButtonState(button, false);
            if (typeof toast !== 'undefined') {
                // Use Bootstrap icon in Toast
                toast.show(`<i class="bi bi-journal-minus"></i> Removed <strong>${name}</strong> from plan.`, 'info');
            }
        } else {
            // --- Add Logic ---
            currentPlan.push({ id, name, lat, lon });

            // Save updates
            if (typeof StorageManager !== 'undefined') {
                StorageManager.set(this.planKey, currentPlan);
            } else {
                localStorage.setItem(this.planKey, JSON.stringify({ data: currentPlan, timestamp: Date.now() }));
            }

            this.setButtonState(button, true);
            if (typeof toast !== 'undefined') {
                // Use Bootstrap icon in Toast
                toast.show(`<i class="bi bi-journal-plus"></i> Added <strong>${name}</strong> to plan!`, 'success');
            }
        }
    }

    // Helper: Update button visual state
    setButtonState(button, isAdded) {
        const icon = button.querySelector('i');
        const text = button.querySelector('span'); // Assuming text is wrapped in span

        if (isAdded) {
            button.classList.add('added');
            if (icon) {
                icon.className = 'bi bi-check2-circle';
            }
            if (text) text.textContent = 'Added';
            button.title = "Click to remove from plan";
        } else {
            button.classList.remove('added');
            if (icon) {
                icon.className = 'bi bi-plus-circle';
            }
            if (text) text.textContent = 'Add to Plan';
            button.title = "Add to trip plan";
        }
    }
}

/* =========================================
   11. LIKE BUTTON (Heart Icon - List View)
   ========================================= */

class LikeButton {
    constructor() {
        this.setupLikeButtons();
    }

    setupLikeButtons() {
        // Only target card-style like buttons in lists, detail page handled separately
        document.querySelectorAll('.js-like-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleLike(e));
        });
    }

    async handleLike(e) {
        e.preventDefault();
        e.stopPropagation(); // Stop clicking card image

        const btn = e.currentTarget;
        const postId = btn.dataset.id;

        if (!postId) return;

        const isLiked = btn.classList.contains('liked');

        // Optimistic UI update
        this.toggleLikeUI(btn, !isLiked);

        try {
            const response = await fetch(`/api/like/${postId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: isLiked ? 'unlike' : 'like'
                })
            });

            if (response.status === 401) {
                window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
                return;
            }

            if (!response.ok) throw new Error('Like failed');

            // Success, do nothing or update counts if needed
        } catch (error) {
            // Revert on error
            this.toggleLikeUI(btn, isLiked);
            console.error('Like error:', error);
            toast.show('Failed to update favorite', 'error');
        }
    }

    toggleLikeUI(btn, liked) {
        const icon = btn.querySelector('i');

        if (liked) {
            btn.classList.add('liked');
            btn.title = 'Remove from favorites';
            if (icon) {
                icon.classList.remove('bi-heart');
                icon.classList.add('bi-heart-fill');
            }
        } else {
            btn.classList.remove('liked');
            btn.title = 'Add to favorites';
            if (icon) {
                icon.classList.remove('bi-heart-fill');
                icon.classList.add('bi-heart');
            }
        }
    }
}

/* =========================================
   12. DESTINATION DETAIL HANDLER
   ========================================= */

class DestinationDetailHandler {
    constructor() {
        this.initSaveButton();
        this.initReviewForm();
        this.initTabs();
        this.initWeather();
    }

    initSaveButton() {
        const saveBtn = document.querySelector('.js-favorite-btn');
        if (!saveBtn) return;

        saveBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            const destId = saveBtn.dataset.id;
            const isActive = saveBtn.classList.contains('active');

            try {
                const response = await fetch(`/api/like/${destId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: isActive ? 'unlike' : 'like' })
                });

                if (response.status === 401) {
                    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
                    return;
                }

                if (!response.ok) throw new Error('Action failed');

                const data = await response.json();

                // Update UI based on new state
                this.updateSaveButtonUI(saveBtn, data.action === 'added');

                toast.show(data.action === 'added' ? 'Added to favorites!' : 'Removed from favorites', 'success');

            } catch (error) {
                console.error('Save error:', error);
                toast.show('Could not save destination', 'error');
            }
        });
    }

    updateSaveButtonUI(btn, isSaved) {
        const icon = btn.querySelector('i');
        const text = btn.querySelector('span');

        if (isSaved) {
            btn.classList.add('active');
            btn.setAttribute('aria-label', 'Remove from favorites');
            if (icon) {
                icon.className = 'bi bi-heart-fill';
            }
            if (text) text.textContent = 'Saved';
        } else {
            btn.classList.remove('active');
            btn.setAttribute('aria-label', 'Add to favorites');
            if (icon) {
                icon.className = 'bi bi-heart';
            }
            if (text) text.textContent = 'Save';
        }
    }

    initReviewForm() {
        const writeBtn = document.getElementById('write-review-btn');
        const formContainer = document.getElementById('review-form-container');
        const cancelBtn = document.getElementById('cancel-review-btn');
        const commentInput = document.getElementById('comment');

        if (!writeBtn || !formContainer) return;

        // Show form
        writeBtn.addEventListener('click', () => {
            formContainer.style.display = 'block';
            writeBtn.style.display = 'none';
            // Smooth scroll to form
            formContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        // Hide form
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                formContainer.style.display = 'none';
                writeBtn.style.display = 'inline-block';
            });
        }

        // Char counter
        if (commentInput) {
            const counter = formContainer.querySelector('.char-count');
            commentInput.addEventListener('input', () => {
                const len = commentInput.value.length;
                if (counter) counter.textContent = `${len} / 500`;
            });
        }
    }

    initTabs() {
        const tabBtns = document.querySelectorAll('.tab-btn');
        if (!tabBtns.length) return;

        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.dataset.tab;

                // Update Buttons
                tabBtns.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');

                // Update Panels
                const panels = document.querySelectorAll('.tab-panel');
                panels.forEach(panel => {
                    panel.classList.remove('active');
                });
                const targetPanel = document.querySelector(`.tab-panel[data-tab="${targetId}"]`);
                if (targetPanel) targetPanel.classList.add('active');
            });
        });
    }

    async initWeather() {
        const widget = document.getElementById('weather-widget');
        if (!widget) {
            console.log('[Weather] Widget not found on this page');
            return;
        }

        const lat = widget.dataset.lat;
        const lon = widget.dataset.lon;

        console.log('[Weather] Initializing weather widget', { lat, lon });

        // Validate coordinates
        if (!lat || !lon || lat === 'None' || lon === 'None') {
            console.error('[Weather] Invalid coordinates');
            const descEl = document.getElementById('weather-desc');
            const iconContainer = document.getElementById('weather-icon-container');
            if (descEl) descEl.textContent = 'Location data unavailable';
            if (iconContainer) iconContainer.innerHTML = '<i class="bi bi-cloud-slash"></i>';
            return;
        }

        try {
            console.log('[Weather] Fetching weather data...');
            const response = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=temperature_2m_max,temperature_2m_min&timezone=auto`
            );

            if (!response.ok) {
                throw new Error(`Weather API returned ${response.status}`);
            }

            const data = await response.json();
            console.log('[Weather] Data received:', data);

            this.renderWeather(data.current_weather, data.daily);

        } catch (error) {
            console.error('[Weather] Fetch failed:', error);
            const descEl = document.getElementById('weather-desc');
            const iconContainer = document.getElementById('weather-icon-container');
            const tipEl = document.getElementById('weather-tip');

            if (descEl) descEl.textContent = 'Weather unavailable';
            if (iconContainer) iconContainer.innerHTML = '<i class="bi bi-cloud-slash" style="font-size: 2.5rem; color: var(--text-secondary);"></i>';
            if (tipEl) tipEl.textContent = 'Unable to load weather data';
        }
    }

    renderWeather(data, daily) {
        const tempEl = document.getElementById('weather-temp');
        const descEl = document.getElementById('weather-desc');
        const iconContainer = document.getElementById('weather-icon-container');
        const tipEl = document.getElementById('weather-tip');

        if (tempEl && daily) {
            const minTemp = Math.round(daily.temperature_2m_min[0]);
            const maxTemp = Math.round(daily.temperature_2m_max[0]);
            tempEl.textContent = `${minTemp}°C - ${maxTemp}°C`;
        } else if (tempEl) {
            tempEl.textContent = `${Math.round(data.temperature)}°C`;
        }

        const weatherInfo = this.getWeatherInfo(data.weathercode);

        if (descEl) descEl.textContent = weatherInfo.desc;
        if (iconContainer) iconContainer.innerHTML = `<i class="bi ${weatherInfo.icon}" style="font-size: 2.5rem; color: var(--primary-color);"></i>`;

        if (tipEl) {
            if (data.temperature > 30) {
                tipEl.textContent = "It's hot today! Stay hydrated.";
            } else if (data.temperature < 10) {
                tipEl.textContent = "Chilly weather. Bring a warm coat!";
            } else if (weatherInfo.isRainy) {
                tipEl.textContent = "Don't forget your umbrella!";
            } else {
                tipEl.textContent = "Great weather for exploring!";
            }
        }
    }

    getWeatherInfo(code) {
        let desc = 'Unknown';
        let icon = 'bi-question-circle';
        let isRainy = false;

        if (code === 0) {
            desc = 'Clear sky';
            icon = 'bi-sun-fill';
        } else if (code >= 1 && code <= 3) {
            desc = 'Partly cloudy';
            icon = 'bi-cloud-sun-fill';
        } else if (code >= 45 && code <= 48) {
            desc = 'Foggy';
            icon = 'bi-cloud-fog2-fill';
        } else if (code >= 51 && code <= 67) {
            desc = 'Rainy';
            icon = 'bi-cloud-drizzle-fill';
            isRainy = true;
        } else if (code >= 71 && code <= 77) {
            desc = 'Snow fall';
            icon = 'bi-cloud-snow-fill';
        } else if (code >= 80 && code <= 82) {
            desc = 'Rain showers';
            icon = 'bi-cloud-rain-heavy-fill';
            isRainy = true;
        } else if (code >= 95) {
            desc = 'Thunderstorm';
            icon = 'bi-cloud-lightning-fill';
            isRainy = true;
        }

        return { desc, icon, isRainy };
    }
}

/* =========================================
   13. SEARCH FUNCTIONALITY
   ========================================= */

class SearchBar {
    constructor() {
        this.searchInput = document.getElementById('search-input');
        this.searchBtn = document.getElementById('search-btn');

        if (this.searchInput) {
            this.init();
        }
    }

    init() {
        this.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.performSearch();
            }
        });

        if (this.searchBtn) {
            this.searchBtn.addEventListener('click', () => this.performSearch());
        }

        // Live search suggestions
        this.searchInput.addEventListener('input', debounce((e) => {
            this.showSuggestions(e.target.value);
        }, 300));
    }

    performSearch() {
        const query = this.searchInput.value.trim();
        if (query) {
            window.location.href = `/destinations?q=${encodeURIComponent(query)}`;
        }
    }

    async showSuggestions(query) {
        if (query.length < 2) return;

        try {
            const response = await fetch(`/api/search_destinations?q=${encodeURIComponent(query)}`);
            const suggestions = await response.json();

            // Display suggestions (implement UI as needed)
            console.log('Suggestions:', suggestions);
        } catch (error) {
            console.error('Search error:', error);
        }
    }
}

/* =========================================
   14. FILTER & SORT
   ========================================= */

class FilterSort {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (this.container) {
            this.init();
        }
    }

    init() {
        const filterBtns = document.querySelectorAll('.filter-btn');
        const sortSelect = document.getElementById('sort-select');

        filterBtns.forEach(btn => {
            btn.addEventListener('click', (e) => this.handleFilter(e));
        });

        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => this.handleSort(e));
        }
    }

    handleFilter(e) {
        const btn = e.currentTarget;
        const filter = btn.dataset.filter;

        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.filterItems(filter);
    }

    filterItems(filter) {
        const items = this.container.querySelectorAll('.filter-item');

        items.forEach(item => {
            if (filter === 'all' || item.dataset.category === filter) {
                item.style.display = '';
                item.classList.add('reveal-on-scroll');
            } else {
                item.style.display = 'none';
            }
        });
    }

    handleSort(e) {
        const sortBy = e.target.value;
        this.sortItems(sortBy);
    }

    sortItems(sortBy) {
        const items = Array.from(this.container.querySelectorAll('.filter-item'));

        items.sort((a, b) => {
            const aValue = a.dataset[sortBy];
            const bValue = b.dataset[sortBy];

            if (sortBy === 'date') {
                return new Date(bValue) - new Date(aValue);
            } else if (sortBy === 'popularity') {
                return parseInt(bValue) - parseInt(aValue);
            } else {
                return aValue.localeCompare(bValue);
            }
        });

        items.forEach(item => this.container.appendChild(item));
    }
}

/* =========================================
   15. FORM ENHANCEMENTS
   ========================================= */

class FormEnhancements {
    constructor() {
        this.setupPasswordToggle();
        this.setupFileUpload();
        this.setupFormValidation();
    }

    setupPasswordToggle() {
        const toggleBtns = document.querySelectorAll('.toggle-password');

        toggleBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const input = btn.previousElementSibling;
                const icon = btn.querySelector('i');

                if (input.type === 'password') {
                    input.type = 'text';
                    icon.classList.remove('bi-eye');
                    icon.classList.add('bi-eye-slash');
                } else {
                    input.type = 'password';
                    icon.classList.remove('bi-eye-slash');
                    icon.classList.add('bi-eye');
                }
            });
        });
    }

    setupFileUpload() {
        const fileInputs = document.querySelectorAll('input[type="file"]');

        fileInputs.forEach(input => {
            input.addEventListener('change', (e) => {
                const fileName = e.target.files[0]?.name;
                const label = input.nextElementSibling;

                if (label && fileName) {
                    label.textContent = fileName;
                }
            });
        });
    }

    setupFormValidation() {
        const forms = document.querySelectorAll('form[data-validate]');

        forms.forEach(form => {
            form.addEventListener('submit', (e) => {
                if (!form.checkValidity()) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                form.classList.add('was-validated');
            });
        });
    }
}

/* =========================================
   16. LAZY LOADING
   ========================================= */

class LazyLoader {
    constructor() {
        this.init();
    }

    init() {
        if ('IntersectionObserver' in window) {
            this.setupObserver();
        } else {
            // Fallback for older browsers
            this.loadAllImages();
        }
    }

    setupObserver() {
        const options = {
            rootMargin: '50px 0px',
            threshold: 0.01
        };

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.loadImage(entry.target);
                    observer.unobserve(entry.target);
                }
            });
        }, options);

        document.querySelectorAll('img[data-src]').forEach(img => {
            observer.observe(img);
        });
    }

    loadImage(img) {
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
        img.classList.add('loaded');
    }

    loadAllImages() {
        document.querySelectorAll('img[data-src]').forEach(img => {
            this.loadImage(img);
        });
    }
}

/* =========================================
   17. PROFILE FORM VALIDATION
   ========================================= */
class ProfileFormValidator {
    constructor(formId) {
        this.form = document.getElementById(formId);

        if (this.form) {
            this.init();
        }
    }

    init() {
        const usernameInput = this.form.querySelector('input[name="username"]');
        const emailInput = this.form.querySelector('input[name="email"]');

        if (usernameInput) {
            usernameInput.addEventListener('blur', () => this.validateUsername(usernameInput));

            const debouncedValidation = debounce(() => {
                if (usernameInput.value.length > 0) {
                    this.validateUsername(usernameInput);
                }
            }, 500);

            usernameInput.addEventListener('input', debouncedValidation);

            usernameInput.addEventListener('focus', () => {
                this.clearFieldError(usernameInput);
            });
        }

        if (emailInput) {
            emailInput.addEventListener('blur', () => this.validateEmail(emailInput));

            const debouncedValidation = debounce(() => {
                if (emailInput.value.length > 0) {
                    this.validateEmail(emailInput);
                }
            }, 500);

            emailInput.addEventListener('input', debouncedValidation);

            emailInput.addEventListener('focus', () => {
                this.clearFieldError(emailInput);
            });
        }

        this.form.addEventListener('submit', (e) => this.handleSubmit(e));
    }

    validateUsername(input) {
        const value = input.value.trim();

        if (value.length < 3) {
            this.showFieldError(input, 'Username must be at least 3 characters');
            return false;
        }

        if (value.length > 50) {
            this.showFieldError(input, 'Username must be less than 50 characters');
            return false;
        }

        if (!/^[a-zA-Z0-9\s._-]+$/.test(value)) {
            this.showFieldError(input, 'Username contains invalid characters');
            return false;
        }

        this.showFieldSuccess(input, 'Username looks good!');
        return true;
    }

    validateEmail(input) {
        const value = input.value.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(value)) {
            this.showFieldError(input, 'Please enter a valid email address');
            return false;
        }

        this.showFieldSuccess(input, 'Email looks good!');
        return true;
    }

    handleSubmit(event) {
        const usernameInput = this.form.querySelector('input[name="username"]');
        const emailInput = this.form.querySelector('input[name="email"]');

        let isValid = true;
        let firstInvalidField = null;

        if (usernameInput) {
            const valid = this.validateUsername(usernameInput);
            if (!valid && !firstInvalidField) {
                firstInvalidField = usernameInput;
            }
            isValid = isValid && valid;
        }

        if (emailInput) {
            const valid = this.validateEmail(emailInput);
            if (!valid && !firstInvalidField) {
                firstInvalidField = emailInput;
            }
            isValid = isValid && valid;
        }

        if (!isValid) {
            event.preventDefault();

            if (firstInvalidField) {
                firstInvalidField.focus();
                firstInvalidField.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }

            if (typeof toast !== 'undefined' && toast.show) {
                toast.show('Please fix the errors before saving', 'error');
            }
        }
    }

    showFieldError(input, message) {
        this.clearFieldError(input);

        input.classList.add('is-invalid');
        input.classList.remove('is-valid');
        input.setAttribute('aria-invalid', 'true');

        const errorDiv = document.createElement('div');
        errorDiv.className = 'field-error';
        errorDiv.setAttribute('role', 'alert');
        errorDiv.innerHTML = `<i class="bi bi-exclamation-circle"></i> ${message}`;

        input.parentElement.appendChild(errorDiv);
    }

    showFieldSuccess(input, message) {
        this.clearFieldError(input);

        input.classList.remove('is-invalid');
        input.classList.add('is-valid');
        input.setAttribute('aria-invalid', 'false');

        const successDiv = document.createElement('div');
        successDiv.className = 'field-success';
        successDiv.innerHTML = `<i class="bi bi-check-circle"></i> ${message}`;

        input.parentElement.appendChild(successDiv);
    }

    clearFieldError(input) {
        input.classList.remove('is-invalid', 'is-valid');
        input.removeAttribute('aria-invalid');

        const parent = input.parentElement;
        const existingFeedback = parent.querySelector('.field-error, .field-success');
        if (existingFeedback) {
            existingFeedback.remove();
        }
    }
}

/* =========================================
   18. SOCIAL SHARE MANAGER
   ========================================= */

class ShareManager {
    constructor() {
        this.shareModal = document.getElementById('share-modal');
        this.init();
    }

    init() {
        this.setupOpenTriggers();
        this.setupShareActions();
        this.setupCloseTriggers();
    }

    setupOpenTriggers() {
        const shareBtns = document.querySelectorAll('.js-share-btn');
        shareBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.openModal();
            });
        });
    }

    setupCloseTriggers() {
        if (!this.shareModal) return;

        const closeBtn = this.shareModal.querySelector('.modal-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.closeModal());

        const backdrop = this.shareModal.querySelector('.modal-backdrop');
        if (backdrop) backdrop.addEventListener('click', () => this.closeModal());
    }

    setupShareActions() {
        if (!this.shareModal) return;

        const url = encodeURIComponent(window.location.href);
        const title = encodeURIComponent(document.title);

        // Facebook
        const fbBtn = this.shareModal.querySelector('[data-share="facebook"]');
        if (fbBtn) {
            fbBtn.addEventListener('click', () => {
                window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, '_blank');
            });
        }

        // Twitter (X)
        const twBtn = this.shareModal.querySelector('[data-share="twitter"]');
        if (twBtn) {
            twBtn.addEventListener('click', () => {
                window.open(`https://twitter.com/intent/tweet?text=${title}&url=${url}`, '_blank');
            });
        }

        // Email
        const mailBtn = this.shareModal.querySelector('[data-share="email"]');
        if (mailBtn) {
            mailBtn.addEventListener('click', () => {
                window.location.href = `mailto:?subject=${title}&body=Check out this destination: ${window.location.href}`;
            });
        }

        // Copy Link
        const copyBtn = this.shareModal.querySelector('.js-copy-link');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(window.location.href).then(() => {
                    const originalHTML = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<i class="bi bi-check2"></i> Copied!';
                    setTimeout(() => {
                        copyBtn.innerHTML = originalHTML;
                    }, 2000);
                    if (typeof toast !== 'undefined') toast.show('Link copied to clipboard!', 'success');
                }).catch(() => {
                    if (typeof toast !== 'undefined') toast.show('Failed to copy link', 'error');
                });
            });
        }
    }

    openModal() {
        if (this.shareModal) {
            this.shareModal.classList.add('active');
            this.shareModal.setAttribute('aria-hidden', 'false');
        }
    }

    closeModal() {
        if (this.shareModal) {
            this.shareModal.classList.remove('active');
            this.shareModal.setAttribute('aria-hidden', 'true');
        }
    }
}

/* =========================================
   19. STANDALONE FUNCTIONS & EVENT LISTENERS
   ========================================= */

// Initialize Edit Review Functionality
document.addEventListener('DOMContentLoaded', () => {
    // 1. Attach Event Listeners to all "Edit" buttons
    const editButtons = document.querySelectorAll('.js-edit-review-btn');
    editButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            // Read data safely from data attributes
            const reviewId = btn.dataset.id;
            const destId = btn.dataset.destId;
            const rating = btn.dataset.rating;
            const comment = btn.dataset.comment;

            openEditReviewModal(reviewId, rating, comment, destId);
        });
    });

    // 2. Attach Close Listeners for the Edit Modal
    const editModal = document.getElementById('edit-review-modal');
    const closeBtn = document.getElementById('close-edit-modal-btn');
    const cancelBtn = document.getElementById('cancel-edit-btn');
    const backdrop = editModal?.querySelector('.modal-backdrop');

    if (editModal) {
        const closeFunc = () => editModal.classList.remove('active');
        if (closeBtn) closeBtn.addEventListener('click', closeFunc);
        if (cancelBtn) cancelBtn.addEventListener('click', closeFunc);
        if (backdrop) backdrop.addEventListener('click', closeFunc);
    }
});

function openEditReviewModal(reviewId, currentRating, currentComment, destId) {
    const modal = document.getElementById('edit-review-modal');
    const form = document.getElementById('edit-review-form');

    if (!modal || !form) return;

    form.action = `/destination/${destId}/review`;

    // Reset radio buttons first
    const radios = form.querySelectorAll('input[name="rating"]');
    radios.forEach(r => r.checked = false);

    // Check the correct rating radio button
    const ratingInput = form.querySelector(`input[name="rating"][value="${currentRating}"]`);
    if (ratingInput) ratingInput.checked = true;

    // Set comment text
    const commentArea = form.querySelector('textarea[name="comment"]');
    if (commentArea) commentArea.value = currentComment || '';

    // Show Modal
    modal.classList.add('active');
}

/* =========================================
   20. INITIALIZATION
   ========================================= */

document.addEventListener('DOMContentLoaded', () => {
    // Core functionality
    new NavigationManager();
    new ScrollReveal();

    // Initialize planner if on planner page
    if (document.getElementById('map')) {
        const planner = new TripPlanner();
        window.planner = planner; // Global access for debugging
    }

    // Initialize Destinations Manager for "Add to Plan" functionality
    new DestinationsManager();

    // Features
    new LikeButton(); // For card view hearts
    new SearchBar();
    new FilterSort('destinations-grid');
    new FormEnhancements();
    new LazyLoader();
    new ShareManager();

    // Destination Detail Page Specifics (Replaces old CommentsSystem)
    if (document.querySelector('.destination-hero')) {
        new DestinationDetailHandler();
    }

    // Page-specific
    const profileForm = document.getElementById('profile-form');
    if (profileForm) {
        new ProfileFormValidator('profile-form');
    }

    // Log initialization
    console.log('[System] Voyager initialized with all features.');
});
// ============================================
// MAP CONTROLS - Layer Switching & POI Filtering
// ============================================

class MapControls {
    constructor(map) {
        this.map = map;
        this.currentLayer = null;
        this.activePOIFilters = new Set();
        this.poiMarkers = new Map();
        this.loadingPOIs = new Set();
        this.lastFetchBounds = new Map();
        this.fetchAttempts = new Map();
        this.moveEndDebounceTimer = null;
        this.DEBOUNCE_DELAY = 800;
        this.MIN_MOVE_DISTANCE = 0.01;

        // Load saved POI filters from localStorage
        this.loadPOIFiltersFromStorage();

        // Define map layers
        this.layers = {
            standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19
            }),
            satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                attribution: '© Esri, Maxar, Earthstar Geographics',
                maxZoom: 19
            }),
            terrain: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
                attribution: '© Esri, USGS, NOAA',
                maxZoom: 19
            })
        };

        // POI category definitions
        this.poiCategories = {
            attractions: {
                icon: '🎭',
                color: '#e74c3c',
                query: 'node["tourism"~"attraction|museum|artwork|viewpoint|gallery"]',
                markerIcon: 'bi-camera'
            },
            restaurants: {
                icon: '🍽️',
                color: '#f39c12',
                query: 'node["amenity"~"restaurant|cafe|fast_food|bar|pub"]',
                markerIcon: 'bi-cup-hot'
            },
            hotels: {
                icon: '🏨',
                color: '#3498db',
                query: 'node["tourism"~"hotel|hostel|guest_house|motel"]',
                markerIcon: 'bi-house-door'
            },
            gas: {
                icon: '⛽',
                color: '#16a085',
                query: 'node["amenity"="fuel"]',
                markerIcon: 'bi-fuel-pump'
            },
            parking: {
                icon: '🅿️',
                color: '#9b59b6',
                query: 'node["amenity"="parking"]',
                markerIcon: 'bi-p-square'
            },
            hospitals: {
                icon: '🏥',
                color: '#e91e63',
                query: 'node["amenity"~"hospital|clinic|doctors|pharmacy"]',
                markerIcon: 'bi-hospital'
            },
            shopping: {
                icon: '🛍️',
                color: '#ff6b6b',
                query: 'node["shop"~"mall|supermarket|department_store|convenience"]',
                markerIcon: 'bi-bag'
            },
            banks: {
                icon: '🏦',
                color: '#2ecc71',
                query: 'node["amenity"~"bank|atm"]',
                markerIcon: 'bi-bank'
            }
        };

        this.init();
    }

    init() {
        this.setLayer('standard');
        this.initLayerSwitcher();
        this.initPOIFilters();
        this.map.on('moveend', () => this.debouncedUpdatePOIs());

        // Restore saved POI filters after map is ready
        this.restoreSavedPOIFilters();
    }

    initLayerSwitcher() {
        const layerButtons = document.querySelectorAll('.map-layer-btn');

        layerButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const layer = e.currentTarget.dataset.layer;
                this.setLayer(layer);

                layerButtons.forEach(btn => btn.classList.remove('active'));
                e.currentTarget.classList.add('active');

                this.showToast(`Map type changed to ${layer}`);
            });
        });
    }

    setLayer(layerName) {
        if (this.currentLayer) {
            this.map.removeLayer(this.currentLayer);
        }

        this.currentLayer = this.layers[layerName];
        this.currentLayer.addTo(this.map);
    }

    initPOIFilters() {
        const filterButtons = document.querySelectorAll('.poi-filter-btn');

        filterButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const poi = e.currentTarget.dataset.poi;
                this.togglePOIFilter(poi, e.currentTarget);
            });
        });

        const clearBtn = document.getElementById('clear-poi-filters');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearAllPOIFilters());
        }
    }

    togglePOIFilter(category, button) {
        if (this.activePOIFilters.has(category)) {
            this.activePOIFilters.delete(category);
            button.classList.remove('active');
            this.removePOIMarkers(category);
            this.lastFetchBounds.delete(category);
        } else {
            this.activePOIFilters.add(category);
            button.classList.add('active');
            this.fetchAndDisplayPOIs(category);
        }

        // Save POI filters to localStorage
        this.savePOIFiltersToStorage();
    }

    clearAllPOIFilters() {
        this.activePOIFilters.clear();
        document.querySelectorAll('.poi-filter-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        this.clearAllPOIMarkers();
        this.lastFetchBounds.clear();

        // Clear saved POI filters from localStorage
        this.clearPOIFiltersFromStorage();

        this.showToast('All POI filters cleared');
    }

    debouncedUpdatePOIs() {
        if (this.moveEndDebounceTimer) {
            clearTimeout(this.moveEndDebounceTimer);
        }

        this.moveEndDebounceTimer = setTimeout(() => {
            this.updateVisiblePOIs();
        }, this.DEBOUNCE_DELAY);
    }

    shouldRefetchPOIs(category) {
        const currentBounds = this.map.getBounds();
        const lastBounds = this.lastFetchBounds.get(category);

        if (!lastBounds) return true;

        const latDiff = Math.abs(currentBounds.getCenter().lat - lastBounds.getCenter().lat);
        const lngDiff = Math.abs(currentBounds.getCenter().lng - lastBounds.getCenter().lng);

        return (latDiff > this.MIN_MOVE_DISTANCE || lngDiff > this.MIN_MOVE_DISTANCE);
    }

    async fetchAndDisplayPOIs(category, isRetry = false) {
        if (this.loadingPOIs.has(category)) {
            console.log(`[POI] Already loading ${category}, skipping...`);
            return;
        }

        const bounds = this.map.getBounds();
        const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

        const categoryDef = this.poiCategories[category];
        const query = `[out:json][timeout:25];(${categoryDef.query}(${bbox}););out body 100;`;

        this.loadingPOIs.add(category);

        try {
            console.log(`[POI] Fetching ${category}...`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                body: query,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            this.fetchAttempts.delete(category);

            this.lastFetchBounds.set(category, bounds);

            // Show marker
            this.displayPOIMarkers(data.elements, category);

            console.log(`[POI] Successfully loaded ${data.elements.length} ${category}`);

        } catch (error) {
            console.error(`[POI] Error fetching ${category}:`, error);

            const attempts = this.fetchAttempts.get(category) || 0;

            if (!isRetry && attempts < 2) {
                this.fetchAttempts.set(category, attempts + 1);
                console.log(`[POI] Retrying ${category} (attempt ${attempts + 1})...`);

                setTimeout(() => {
                    this.fetchAndDisplayPOIs(category, true);
                }, 2000);
            } else {
                this.showToast(`Could not load ${category}. Please try again later.`, 'error');
                this.fetchAttempts.delete(category);
            }
        } finally {
            // Remove loading marker
            this.loadingPOIs.delete(category);
        }
    }

    displayPOIMarkers(pois, category) {
        const categoryDef = this.poiCategories[category];

        this.removePOIMarkers(category);

        let addedCount = 0;

        pois.forEach(poi => {
            if (!poi.lat || !poi.lon) return;

            const markerId = `${category}-${poi.id}`;

            if (this.poiMarkers.has(markerId)) {
                return;
            }

            const iconHTML = `
                <div class="poi-marker" style="background-color: ${categoryDef.color}">
                    <i class="bi ${categoryDef.markerIcon}"></i>
                </div>
            `;

            const icon = L.divIcon({
                html: iconHTML,
                className: 'poi-marker-container',
                iconSize: [32, 32],
                iconAnchor: [16, 32],
                popupAnchor: [0, -32]
            });

            const marker = L.marker([poi.lat, poi.lon], { icon })
                .bindPopup(this.createPOIPopup(poi, category))
                .addTo(this.map);

            marker.poiCategory = category;
            marker.poiId = markerId;

            this.poiMarkers.set(markerId, marker);
            addedCount++;
        });

        if (addedCount > 0) {
            this.showToast(`Loaded ${addedCount} ${category}`);
        }
    }

    createPOIPopup(poi, category) {
        const name = poi.tags?.name || 'Unknown';
        const address = poi.tags?.['addr:street'] || '';
        const housenumber = poi.tags?.['addr:housenumber'] || '';
        const fullAddress = housenumber && address ? `${housenumber} ${address}` : address;

        let popupContent = `
            <div class="poi-popup">
                <div class="poi-popup-header">
                    <i class="bi ${this.poiCategories[category].markerIcon}"></i>
                    <strong>${name}</strong>
                </div>
        `;

        if (fullAddress) {
            popupContent += `<p class="poi-address"><i class="bi bi-geo-alt"></i> ${fullAddress}</p>`;
        }

        if (poi.tags?.phone) {
            popupContent += `<p class="poi-contact"><i class="bi bi-telephone"></i> ${poi.tags.phone}</p>`;
        }

        if (poi.tags?.website) {
            popupContent += `
                <p class="poi-website">
                    <a href="${poi.tags.website}" target="_blank" rel="noopener">
                        <i class="bi bi-link-45deg"></i> Website
                    </a>
                </p>
            `;
        }

        popupContent += `
                <button class="btn-add-poi" onclick="addPOIToRoute(${poi.lat}, ${poi.lon}, '${name.replace(/'/g, "\\'")}')">
                    <i class="bi bi-plus-circle"></i> Add to Route
                </button>
            </div>
        `;

        return popupContent;
    }

    removePOIMarkers(category) {
        const markersToRemove = [];

        this.poiMarkers.forEach((marker, markerId) => {
            if (marker.poiCategory === category) {
                this.map.removeLayer(marker);
                markersToRemove.push(markerId);
            }
        });

        markersToRemove.forEach(id => this.poiMarkers.delete(id));
    }

    clearAllPOIMarkers() {
        this.poiMarkers.forEach(marker => this.map.removeLayer(marker));
        this.poiMarkers.clear();
    }

    updateVisiblePOIs() {
        console.log('[POI] Checking if POIs need update...');

        this.activePOIFilters.forEach(category => {
            if (this.shouldRefetchPOIs(category)) {
                console.log(`[POI] Updating ${category} POIs due to map movement`);
                this.removePOIMarkers(category);
                this.fetchAndDisplayPOIs(category);
            } else {
                console.log(`[POI] Keeping ${category} POIs (movement too small)`);
            }
        });
    }

    // localStorage methods for POI filters persistence
    savePOIFiltersToStorage() {
        try {
            const filtersArray = Array.from(this.activePOIFilters);
            localStorage.setItem('voyager_active_poi_filters', JSON.stringify(filtersArray));
        } catch (error) {
            console.error('Error saving POI filters to localStorage:', error);
        }
    }

    loadPOIFiltersFromStorage() {
        try {
            const saved = localStorage.getItem('voyager_active_poi_filters');
            if (saved) {
                const filtersArray = JSON.parse(saved);
                this.activePOIFilters = new Set(filtersArray);
            }
        } catch (error) {
            console.error('Error loading POI filters from localStorage:', error);
            this.activePOIFilters = new Set();
        }
    }

    restoreSavedPOIFilters() {
        // Restore button states and fetch POIs for saved filters
        this.activePOIFilters.forEach(category => {
            const button = document.querySelector(`.poi-filter-btn[data-poi="${category}"]`);
            if (button) {
                button.classList.add('active');
                setTimeout(() => {
                    this.fetchAndDisplayPOIs(category);
                }, 300);
            }
        });
    }

    clearPOIFiltersFromStorage() {
        try {
            localStorage.removeItem('voyager_active_poi_filters');
        } catch (error) {
            console.error('Error clearing POI filters from localStorage:', error);
        }
    }

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `map-toast map-toast-${type}`;
        toast.innerHTML = `
            <i class="bi bi-${type === 'error' ? 'exclamation-triangle' : 'check-circle'}"></i>
            <span>${message}</span>
        `;

        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

function addPOIToRoute(lat, lon, name) {
    console.log('[POI] Adding to route:', name, lat, lon);

    if (window.tripPlanner && typeof window.tripPlanner.addLocationToRoute === 'function') {
        window.tripPlanner.addLocationToRoute(lat, lon, name);

        const toast = document.createElement('div');
        toast.className = 'map-toast map-toast-success';
        toast.innerHTML = `
            <i class="bi bi-check-circle"></i>
            <span>Added "${name}" to route</span>
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    } else {
        console.error('[POI] TripPlanner not available');
        const toast = document.createElement('div');
        toast.className = 'map-toast map-toast-error';
        toast.innerHTML = `
            <i class="bi bi-exclamation-triangle"></i>
            <span>Unable to add to route. Please refresh the page.</span>
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

window.addPOIToRoute = addPOIToRoute;

// Initialize MapControls when TripPlanner initializes
if (typeof TripPlanner !== 'undefined') {
    const originalInitMap = TripPlanner.prototype.initMap;

    TripPlanner.prototype.initMap = function () {
        this.state.map = L.map('map').setView([20, 0], 2);

        // Initialize MapControls (which will add the default layer)
        this.mapControls = new MapControls(this.state.map);

        // Store reference globally for POI adding
        window.tripPlanner = this;

        // Initialize markers layer
        this.state.markersLayer = L.layerGroup().addTo(this.state.map);
        this.state.routeLayer = L.layerGroup().addTo(this.state.map);
    };
}

/* ================================================================================
   PAGE: AUTH (Login/Register) 
   ================================================================================ */

class PasswordStrengthChecker {
    constructor() {
        this.passwordInput = null;
        this.confirmInput = null;
        this.strengthIndicator = null;
        this.strengthBarFill = null;
        this.strengthLabel = null;
        this.matchHint = null;

        this.init();
    }

    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setup());
        } else {
            this.setup();
        }
    }

    setup() {
        // Get element
        this.passwordInput = document.getElementById('password');
        this.confirmInput = document.getElementById('confirm_password');
        this.strengthIndicator = document.getElementById('password-strength');
        this.strengthBarFill = document.getElementById('strength-bar-fill');
        this.strengthLabel = document.getElementById('strength-label');
        this.matchHint = document.getElementById('password-match-hint');

        if (!this.passwordInput) {
            return;
        }

        this.bindEvents();
    }

    bindEvents() {
        this.passwordInput.addEventListener('input', () => {
            this.checkPasswordStrength();
            this.checkPasswordMatch();
        });

        if (this.confirmInput) {
            this.confirmInput.addEventListener('input', () => {
                this.checkPasswordMatch();
            });
        }
    }

    checkPasswordStrength() {
        const password = this.passwordInput.value;

        if (password.length === 0) {
            if (this.strengthIndicator) {
                this.strengthIndicator.style.display = 'none';
            }
            return;
        }

        // Show indicator
        if (this.strengthIndicator) {
            this.strengthIndicator.style.display = 'block';
        }

        // Check
        const requirements = {
            length: password.length >= 8,
            uppercase: /[A-Z]/.test(password),
            lowercase: /[a-z]/.test(password),
            number: /\d/.test(password)
        };

        // Update requirements list display
        this.updateRequirement('req-length', requirements.length);
        this.updateRequirement('req-uppercase', requirements.uppercase);
        this.updateRequirement('req-lowercase', requirements.lowercase);
        this.updateRequirement('req-number', requirements.number);

        const metRequirements = Object.values(requirements).filter(Boolean).length;
        let strength = 'weak';

        if (metRequirements === 4) {
            strength = 'strong';
        } else if (metRequirements === 3) {
            strength = 'good';
        } else if (metRequirements === 2) {
            strength = 'fair';
        }

        // Update strength bar
        if (this.strengthBarFill) {
            this.strengthBarFill.className = 'strength-bar-fill ' + strength;
        }

        // Update strength label
        if (this.strengthLabel) {
            const strengthText = {
                'weak': 'Weak',
                'fair': 'Fair',
                'good': 'Good',
                'strong': 'Strong'
            };

            this.strengthLabel.textContent = strengthText[strength];
            this.strengthLabel.className = strength;
        }
    }

    updateRequirement(elementId, met) {
        const element = document.getElementById(elementId);
        if (!element) return;

        const icon = element.querySelector('i');

        if (met) {
            element.classList.add('met');
            if (icon) {
                icon.className = 'bi bi-check-circle';
            }
        } else {
            element.classList.remove('met');
            if (icon) {
                icon.className = 'bi bi-x-circle';
            }
        }
    }

    checkPasswordMatch() {
        if (!this.confirmInput || !this.matchHint) {
            return;
        }

        const password = this.passwordInput.value;
        const confirm = this.confirmInput.value;

        if (confirm.length === 0) {
            this.matchHint.style.display = 'none';
            return;
        }

        // Show hint
        this.matchHint.style.display = 'block';

        // Check if match
        if (confirm === password) {
            this.matchHint.textContent = '✓ Passwords match';
            this.matchHint.className = 'form-hint match';
        } else {
            this.matchHint.textContent = '✗ Passwords do not match';
            this.matchHint.className = 'form-hint no-match';
        }
    }
}

class FormValidationEnhancer {
    constructor() {
        this.init();
    }

    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setup());
        } else {
            this.setup();
        }
    }

    setup() {
        const form = document.getElementById('register-form');
        if (!form) return;

        // Add client-side validation
        form.addEventListener('submit', (e) => {
            if (!this.validateForm(form)) {
                e.preventDefault();
            }
        });

        this.setupRealtimeValidation(form);
    }

    validateForm(form) {
        let isValid = true;

        // Validate all required fields
        const requiredInputs = form.querySelectorAll('[required]');
        requiredInputs.forEach(input => {
            if (!input.value.trim()) {
                this.showFieldError(input, 'This field is required');
                isValid = false;
            }
        });

        // Validate email format
        const emailInput = form.querySelector('[type="email"]');
        if (emailInput && emailInput.value) {
            const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
            if (!emailPattern.test(emailInput.value)) {
                this.showFieldError(emailInput, 'Invalid email format');
                isValid = false;
            }
        }

        // Validate password match
        const password = form.querySelector('#password');
        const confirm = form.querySelector('#confirm_password');
        if (password && confirm && password.value !== confirm.value) {
            this.showFieldError(confirm, 'Passwords do not match');
            isValid = false;
        }

        return isValid;
    }

    setupRealtimeValidation(form) {
        const usernameInput = form.querySelector('#username');
        if (usernameInput) {
            usernameInput.addEventListener('blur', () => {
                const value = usernameInput.value.trim();
                if (value.length > 0 && value.length < 3) {
                    this.showFieldError(usernameInput, 'Username must be at least 3 characters');
                } else if (value.length > 50) {
                    this.showFieldError(usernameInput, 'Username is too long');
                } else if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                    this.showFieldError(usernameInput, 'Only letters, numbers, underscore and hyphen allowed');
                } else {
                    this.clearFieldError(usernameInput);
                }
            });
        }

        const emailInput = form.querySelector('#email');
        if (emailInput) {
            emailInput.addEventListener('blur', () => {
                const value = emailInput.value.trim();
                const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
                if (value.length > 0 && !emailPattern.test(value)) {
                    this.showFieldError(emailInput, 'Please enter a valid email address');
                } else {
                    this.clearFieldError(emailInput);
                }
            });
        }
    }

    showFieldError(input, message) {
        input.classList.add('is-invalid');

        // Remove old error message
        const oldError = input.parentElement.querySelector('.field-error');
        if (oldError) {
            oldError.remove();
        }

        // Add new error message
        const errorDiv = document.createElement('div');
        errorDiv.className = 'field-error';
        errorDiv.style.color = '#ef4444';
        errorDiv.style.fontSize = '0.75rem';
        errorDiv.style.marginTop = '0.25rem';
        errorDiv.textContent = message;

        input.parentElement.appendChild(errorDiv);
    }

    clearFieldError(input) {
        input.classList.remove('is-invalid');

        const errorDiv = input.parentElement.querySelector('.field-error');
        if (errorDiv) {
            errorDiv.remove();
        }
    }
}

// =========================================
// Initialize
// =========================================

// Create global instance
if (typeof window !== 'undefined') {
    window.passwordStrengthChecker = new PasswordStrengthChecker();
    window.formValidationEnhancer = new FormValidationEnhancer();
}
// =========================================
// Profile Page - Logout Modal Functions
// =========================================
function showLogoutModal() {
    const modal = document.getElementById('logout-modal');
    if (modal) {
        modal.style.display = 'flex';
        // Prevent background scrolling
        document.body.classList.add('modal-open');
        modal.setAttribute('tabindex', '-1');
        modal.focus();
        // Addkeyboard event listener
        document.addEventListener('keydown', handleLogoutModalKeydown);
    }
}

function hideLogoutModal() {
    const modal = document.getElementById('logout-modal');
    if (modal) {
        modal.style.display = 'none';
        // Restore background scrolling
        document.body.classList.remove('modal-open');
        // Removekeyboard event listener
        document.removeEventListener('keydown', handleLogoutModalKeydown);
    }
}

function handleLogoutModalKeydown(e) {
    if (e.key === 'Escape') {
        hideLogoutModal();
    }
}

if (typeof window !== 'undefined') {
    document.addEventListener('click', function (e) {
        const modal = document.getElementById('logout-modal');
        if (modal && e.target === modal) {
            hideLogoutModal();
        }
    });
}

// =========================================
// Profile Page - Avatar Change Handler
// =========================================

function handleAvatarChange(input) {
    if (!input.files || !input.files[0]) {
        return;
    }

    const file = input.files[0];
    console.log('Avatar selected:', file.name, file.type, file.size);

    // 1. Validate file type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
        toast.show('Please upload a valid image file (PNG, JPG, GIF, or WEBP)', 'error');
        input.value = '';
        return;
    }

    // 2. Validate file size (5MB max)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
        toast.show('Image size must be less than 5MB', 'error');
        input.value = '';
        return;
    }

    // 3. Preview image
    const reader = new FileReader();
    reader.onload = function (e) {
        const preview = document.getElementById('avatar-preview');
        if (preview) {
            preview.src = e.target.result;
            console.log('Avatar preview updated');
        }
    };
    reader.onerror = function () {
        console.error('FileReader error');
        toast.show('Error reading image file', 'error');
        input.value = '';
    };
    reader.readAsDataURL(file);

    // 4. Get form and verify all fields
    const form = document.getElementById('profile-form');
    if (!form) {
        console.error('Profile form not found!');
        toast.show('Form not found. Please refresh the page.', 'error');
        input.value = '';
        return;
    }

    // 5. CRITICAL FIX: Verify form fields have values
    // Sometimes browser doesn't properly read {{ user.username }} on first load
    const username = form.querySelector('#username');
    const email = form.querySelector('#email');
    const bio = form.querySelector('#bio');

    // Log current values for debugging
    console.log('Form field values before submission:');
    console.log('  Username:', username ? username.value : 'FIELD NOT FOUND');
    console.log('  Email:', email ? email.value : 'FIELD NOT FOUND');
    console.log('  Bio:', bio ? bio.value : 'FIELD NOT FOUND');

    // Check if fields exist
    if (!username) {
        console.error('Username field not found in form!');
        toast.show('Form error: Username field missing', 'error');
        input.value = '';
        return;
    }

    if (!email) {
        console.error('Email field not found in form!');
        toast.show('Form error: Email field missing', 'error');
        input.value = '';
        return;
    }

    // CRITICAL: Check if values are actually present
    // If Jinja2 template didn't populate, warn user
    if (!username.value || username.value.trim() === '') {
        console.error('Username field is empty! This should not happen.');
        toast.show('Please fill in your username in the form below first', 'error');
        input.value = '';
        // Scroll to the form so user can see it
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
    }

    if (!email.value || email.value.trim() === '') {
        console.error('Email field is empty! This should not happen.');
        toast.show('Please fill in your email in the form below first', 'error');
        input.value = '';
        // Scroll to the form so user can see it
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
    }

    // 6. All validations passed - submit the form
    console.log('All validations passed. Submitting form...');
    toast.show('Uploading avatar...', 'info', 3000);

    setTimeout(() => {
        try {
            console.log('Calling form.submit()...');
            form.submit();
        } catch (e) {
            console.error('Form submission error:', e);
            toast.show('Submission error. Please try again.', 'error');
            input.value = '';
        }
    }, 500);
}


// =========================================
// DELETE TRIP FUNCTIONALITY
// =========================================

/**
 * Delete trip from route detail page
 * @param {number} tripId - The ID of the trip to delete
 */
function deleteTrip(tripId) {
    if (!confirm('Are you sure you want to delete this trip? This action cannot be undone.')) {
        return;
    }

    fetch(`/api/delete_trip/${tripId}`, {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                showToast('Trip deleted successfully', 'success');
                setTimeout(() => {
                    window.location.href = '/profile';
                }, 1000);
            } else {
                showToast(data.message || 'Failed to delete trip', 'error');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to delete trip', 'error');
        });
}

/**
 * Copy current page link to clipboard
 */
function copyLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied to clipboard!', 'success');
    }).catch(() => {
        showToast('Failed to copy link', 'error');
    });
}

/**
 * Copy route link to clipboard (for featured routes)
 */
function copyRouteLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Route link copied to clipboard!', 'success');
    }).catch(() => {
        showToast('Failed to copy route link', 'error');
    });
}

/**
 * Toggle trip public/private status
 * @param {number} tripId - The ID of the trip
 * @param {boolean} isCurrentlyPublic - Current public status
 */
function toggleTripPublic(tripId, isCurrentlyPublic) {
    // Confirm action
    const action = isCurrentlyPublic ? 'private' : 'public';
    const confirmMsg = `Are you sure you want to make this trip ${action}?`;

    if (!confirm(confirmMsg)) {
        return;
    }

    // Show loading state
    const btn = document.getElementById('toggle-public-btn');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Processing...';

    // Make AJAX request to toggle
    fetch(`/toggle_public/${tripId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        credentials: 'same-origin'
    })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => {
                    throw new Error(err.error || 'Network response was not ok');
                });
            }
            return response.json();
        })
        .then(data => {
            if (data.success) {
                // Show success message
                if (typeof toast !== 'undefined') {
                    toast.show(data.message || `Trip is now ${action}!`, 'success');
                } else {
                    alert(data.message || `Trip is now ${action}!`);
                }

                // Reload page to reflect changes
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
            } else {
                throw new Error(data.error || 'Failed to update trip visibility');
            }
        })
        .catch(error => {
            console.error('Error toggling trip visibility:', error);

            // Show error message
            const errorMsg = error.message || 'Failed to update trip visibility. Please try again.';
            if (typeof toast !== 'undefined') {
                toast.show(errorMsg, 'error');
            } else {
                alert(errorMsg);
            }

            // Restore button
            btn.disabled = false;
            btn.innerHTML = originalHTML;
        });
}

/**
 * Delete a trip
 * @param {number} tripId - The ID of the trip to delete
 */
function deleteTrip(tripId) {
    // Confirm deletion
    if (!confirm('Are you sure you want to delete this trip? This action cannot be undone.')) {
        return;
    }

    // Show loading state
    const btn = event.target.closest('button');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Deleting...';

    fetch(`/api/delete_trip/${tripId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        credentials: 'same-origin'
    })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => {
                    throw new Error(err.message || 'Network response was not ok');
                });
            }
            return response.json();
        })
        .then(data => {
            // Check if deletion was successful
            if (data.status === 'success') {
                // Show success message
                if (typeof toast !== 'undefined') {
                    toast.show(data.message || 'Trip deleted successfully!', 'success');
                } else {
                    alert(data.message || 'Trip deleted successfully!');
                }

                // Redirect to my trips page
                setTimeout(() => {
                    window.location.href = '/my_trips';
                }, 1000);
            } else {
                throw new Error(data.message || 'Failed to delete trip');
            }
        })
        .catch(error => {
            console.error('Error deleting trip:', error);

            // Show error message
            const errorMsg = error.message || 'Failed to delete trip. Please try again.';
            if (typeof toast !== 'undefined') {
                toast.show(errorMsg, 'error');
            } else {
                alert(errorMsg);
            }

            // Restore button
            btn.disabled = false;
            btn.innerHTML = originalHTML;
        });
}

// Make sure functions are globally available
window.toggleTripPublic = toggleTripPublic;
window.deleteTrip = deleteTrip;

console.log('[Route Detail] Fixed functions loaded: toggleTripPublic, deleteTrip');


// =========================================
// PROFILE PAGE FUNCTIONALITY
// =========================================

// Toggle edit profile form visibility
function toggleEditProfile() {
    const form = document.getElementById('edit-profile-form');
    if (form) {
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }
}

/**
 * Load user trips for profile page
 */
async function loadTrips() {
    try {
        const response = await fetch('/api/my_trips');
        const data = await response.json();

        const container = document.getElementById('trips-container');
        const noTripsMsg = document.getElementById('no-trips-message');

        if (!container) return; // Not on profile page

        if (data.trips && data.trips.length > 0) {
            container.innerHTML = data.trips.map(trip => createTripCard(trip)).join('');
            if (noTripsMsg) noTripsMsg.style.display = 'none';
        } else {
            container.innerHTML = '';
            if (noTripsMsg) noTripsMsg.style.display = 'block';
        }
    } catch (error) {
        console.error('Error loading trips:', error);
        const container = document.getElementById('trips-container');
        if (container) {
            container.innerHTML = '<div class="alert alert-error">Failed to load trips</div>';
        }
    }
}

/**
 * Create trip card HTML
 * @param {Object} trip - Trip data object
 * @returns {string} HTML string for trip card
 */
function createTripCard(trip) {
    const defaultImage = 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=400&h=300&fit=crop';
    const thumbnail = trip.thumbnail || defaultImage;
    const privacyIcon = trip.is_public ? 'bi-globe' : 'bi-lock-fill';
    const privacyText = trip.is_public ? 'Public' : 'Private';

    return `
        <div class="trip-card" id="trip-${trip.id}">
            <div class="trip-thumbnail">
                <img src="${thumbnail}" 
                     alt="${trip.name}" 
                     onerror="this.src='${defaultImage}'; this.onerror=null;">
            </div>
            <div class="trip-info">
                <h3>${trip.name}</h3>
                <div class="trip-meta">
                    <span><i class="bi bi-calendar3"></i> ${trip.created_at}</span>
                    <span><i class="bi bi-geo-alt-fill"></i> ${trip.total_stops} Stops</span>
                    <span><i class="${privacyIcon}"></i> ${privacyText}</span>
                </div>
                <div class="trip-actions">
                    <a href="/route/${trip.id}" class="btn btn-outline-primary">
                        <i class="bi bi-eye"></i> View Details
                    </a>
                    <button class="btn btn-outline-danger" onclick="deleteTripFromProfile(${trip.id})">
                        <i class="bi bi-trash"></i> Delete
                    </button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Delete trip from profile page with animation
 * @param {number} tripId - The ID of the trip to delete
 */
function deleteTripFromProfile(tripId) {
    if (!confirm('Are you sure you want to delete this trip? This action cannot be undone.')) {
        return;
    }

    const tripCard = document.getElementById(`trip-${tripId}`);
    if (tripCard) {
        tripCard.style.opacity = '0.5';
        tripCard.style.pointerEvents = 'none';
    }

    fetch(`/api/delete_trip/${tripId}`, {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                showToast('Trip deleted successfully', 'success');

                if (tripCard) {
                    tripCard.style.transition = 'all 0.3s ease-out';
                    tripCard.style.transform = 'scale(0.8)';
                    tripCard.style.opacity = '0';

                    setTimeout(() => {
                        tripCard.remove();

                        const remainingTrips = document.querySelectorAll('.trip-card');
                        if (remainingTrips.length === 0) {
                            const container = document.getElementById('trips-container');
                            const noTripsMsg = document.getElementById('no-trips-message');
                            if (container) container.innerHTML = '';
                            if (noTripsMsg) noTripsMsg.style.display = 'block';
                        }
                    }, 300);
                }
            } else {
                showToast(data.message || 'Failed to delete trip', 'error');
                if (tripCard) {
                    tripCard.style.opacity = '1';
                    tripCard.style.pointerEvents = 'auto';
                }
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to delete trip', 'error');
            if (tripCard) {
                tripCard.style.opacity = '1';
                tripCard.style.pointerEvents = 'auto';
            }
        });
}
/**
 * Initialize profile page functionality
 */
function initProfilePage() {
    const tripsContainer = document.getElementById('trips-container');
    if (tripsContainer) {
        loadTrips();
    }
}

/**
 * Initialize route detail page functionality
 */

class RouteDetailMap {
    constructor(tripData) {
        this.tripData = tripData;
        this.map = null;
        this.markers = [];
        this.polylines = [];

        this.transportMode = tripData.transport_mode || 'driving-car';

        console.log('[Route Detail] RouteDetailMap created with transport mode:', this.transportMode);
    }

    async init() {
        const mapElement = document.getElementById('route-map');
        if (!mapElement) {
            console.error('[Route Detail] Map element not found');
            return;
        }

        const allStops = [];
        if (this.tripData.days) {
            this.tripData.days.forEach(day => {
                if (day.stops) {
                    day.stops.forEach(stop => {
                        allStops.push({
                            lat: stop.lat,
                            lon: stop.lon,
                            name: stop.name
                        });
                    });
                }
            });
        }

        if (allStops.length === 0) {
            console.warn('[Route Detail] No stops found');
            return;
        }

        console.log('[Route Detail] Found', allStops.length, 'stops');

        this.map = L.map('route-map');
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19
        }).addTo(this.map);

        await this.drawRoutesWithColors();

        const allLatLngs = allStops.map(stop => [stop.lat, stop.lon]);
        const bounds = L.latLngBounds(allLatLngs);
        this.map.fitBounds(bounds, { padding: [50, 50] });

        console.log('[Route Detail] Map initialization complete');
    }

    async drawRoutesWithColors() {
        if (!this.tripData.days) return;

        console.log('[Route Detail] Drawing routes for', this.tripData.days.length, 'days');

        for (const day of this.tripData.days) {
            const dayColor = this.getColorForDay(day.number);

            if (!day.stops || day.stops.length < 1) continue;

            day.stops.forEach((stop, index) => {
                this.addMarker(stop, index + 1, dayColor);
            });

            if (day.stops.length >= 2) {
                for (let i = 0; i < day.stops.length - 1; i++) {
                    const from = day.stops[i];
                    const to = day.stops[i + 1];

                    console.log(`[Route Detail] Calculating route from "${from.name}" to "${to.name}"`);

                    try {
                        const route = await this.getRouteFromOSRM(from, to);

                        if (route && route.coordinates && route.coordinates.length > 0) {
                            console.log(`[Route Detail] ✅ Got route with ${route.coordinates.length} points`);

                            const polyline = L.polyline(route.coordinates, {
                                color: dayColor,
                                weight: 6,
                                opacity: 0.9,
                                lineCap: 'round',
                                lineJoin: 'round'
                            }).addTo(this.map);

                            this.polylines.push(polyline);
                        } else {
                            console.warn('[Route Detail] ⚠️ No route coordinates, drawing straight line');
                            this.drawStraightLine(from, to, dayColor);
                        }
                    } catch (error) {
                        console.error(`[Route Detail] ❌ Route calculation error:`, error);
                        this.drawStraightLine(from, to, dayColor);
                    }
                }
            }
        }

        console.log('[Route Detail] All routes drawn');
    }

    async getRouteFromOSRM(from, to) {
        let osrmProfile = 'car';

        if (this.transportMode === 'foot-walking') {
            osrmProfile = 'foot';
        } else if (this.transportMode === 'cycling-regular') {
            osrmProfile = 'bike';
        } else {
            osrmProfile = 'car';
        }

        const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${from.lon},${from.lat};${to.lon},${to.lat}`;
        const params = new URLSearchParams({
            overview: 'full',
            geometries: 'geojson'
        });

        console.log(`[Route Detail] Calling OSRM (${osrmProfile}):`, url + '?' + params);

        try {
            const response = await fetch(url + '?' + params, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`OSRM HTTP error: ${response.status}`);
            }

            const data = await response.json();

            if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
                const route = data.routes[0];

                const coordinates = route.geometry.coordinates.map(coord => [coord[1], coord[0]]);

                console.log(`[Route Detail] OSRM returned ${coordinates.length} coordinate points`);

                return {
                    coordinates: coordinates,
                    distance: route.distance / 1000,
                    duration: route.duration / 60,
                    provider: 'OSRM'
                };
            } else {
                console.error('[Route Detail] OSRM response code:', data.code);
                return null;
            }
        } catch (error) {
            console.error('[Route Detail] OSRM fetch error:', error);
            return null;
        }
    }

    drawStraightLine(from, to, color) {
        console.log('[Route Detail] Drawing straight line as fallback');

        const polyline = L.polyline([
            [from.lat, from.lon],
            [to.lat, to.lon]
        ], {
            color: color,
            weight: 4,
            opacity: 0.6,
            dashArray: '10, 10'
        }).addTo(this.map);

        this.polylines.push(polyline);
    }

    addMarker(stop, number, color) {
        const marker = L.marker([stop.lat, stop.lon]).addTo(this.map);
        marker.bindPopup(`<b>${number}. ${stop.name}</b>`);
        this.markers.push(marker);
    }

    getColorForDay(dayNumber) {
        const colors = [
            '#2563eb', // Blue
            '#dc2626', // Red
            '#16a34a', // Green
            '#ea580c', // Orange
            '#9333ea', // Purple
            '#0891b2', // Cyan
            '#ca8a04', // Yellow
            '#be185d'  // Pink
        ];
        return colors[(dayNumber - 1) % colors.length];
    }
}

/* =========================================
   Initialization Functions
   ========================================= */

// 1. Main entry function for initialization (modified to async)
async function initRouteDetailPage() {
    await initializeFeaturedRouteMap();
}

// 2. Map initialization logic (modified to use RouteDetailMap class)
async function initializeFeaturedRouteMap() {
    const mapElement = document.getElementById('route-map');
    if (!mapElement) return;

    if (typeof window.featuredRouteTripData === 'undefined') {
        console.error('[Route Detail] Trip data not found');
        return;
    }

    const tripData = window.featuredRouteTripData;

    if (!tripData.days || tripData.days.length === 0) {
        console.warn('[Route Detail] No days data found');
        return;
    }

    console.log('[Route Detail] Initializing map with trip data:', tripData);

    // Use new RouteDetailMap class - automatically reuses all Planner route logic
    const routeMap = new RouteDetailMap(tripData);
    await routeMap.init();
}

// 3. Copy link functionality (keep unchanged)
function copyRouteLink() {
    const url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
            if (typeof showToast === 'function') showToast('Link copied to clipboard!', 'success');
        }).catch(err => {
            console.error('Failed to copy:', err);
            fallbackCopyLink(url);
        });
    } else {
        fallbackCopyLink(url);
    }
}

function fallbackCopyLink(url) {
    const textArea = document.createElement('textarea');
    textArea.value = url;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
        if (typeof showToast === 'function') showToast('Link copied to clipboard!', 'success');
    } catch (err) {
        if (typeof showToast === 'function') showToast('Failed to copy link', 'error');
    }
    document.body.removeChild(textArea);
}

// 3. Copy link functionality (moved to outer scope)
function copyRouteLink() {
    const url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => {
            if (typeof showToast === 'function') showToast('Link copied to clipboard!', 'success');
        }).catch(err => {
            console.error('Failed to copy:', err);
            fallbackCopyLink(url);
        });
    } else {
        fallbackCopyLink(url);
    }
}

function fallbackCopyLink(url) {
    const textArea = document.createElement('textarea');
    textArea.value = url;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
        if (typeof showToast === 'function') showToast('Link copied to clipboard!', 'success');
    } catch (err) {
        if (typeof showToast === 'function') showToast('Failed to copy link', 'error');
    }
    document.body.removeChild(textArea);
}

/* =========================================
   GLOBAL INITIALIZATION
   ========================================= */

document.addEventListener('DOMContentLoaded', async function () {
    // Check if on Profile page
    if (document.getElementById('trips-container')) {
        if (typeof initProfilePage === 'function') initProfilePage();
    }

    // Check if on Route Detail page
    if (document.querySelector('.route-header')) {
        await initRouteDetailPage(); // Call the entry function above
    }
});

// Expose global functions for onclick usage in HTML
if (typeof window !== 'undefined') {
    window.deleteTrip = typeof deleteTrip !== 'undefined' ? deleteTrip : null;
    window.deleteTripFromProfile = typeof deleteTripFromProfile !== 'undefined' ? deleteTripFromProfile : null;
    window.copyRouteLink = copyRouteLink; // Fixed: expose copyRouteLink
    window.copyLink = typeof copyLink !== 'undefined' ? copyLink : null;
    window.copyRouteLink = typeof copyRouteLink !== 'undefined' ? copyRouteLink : null;
    window.togglePublicStatus = typeof togglePublicStatus !== 'undefined' ? togglePublicStatus : null;
    window.toggleEditProfile = typeof toggleEditProfile !== 'undefined' ? toggleEditProfile : null;
    window.loadTrips = typeof loadTrips !== 'undefined' ? loadTrips : null;
    window.showToast = typeof showToast !== 'undefined' ? showToast : null;
}

/* =========================================
   TRIP REVIEWS, LIKES & FAVORITES
   Review, like, and favorite functionality for Community page
   ========================================= */

/**
 * Trip Like Button Handler
 * Handles trip like functionality
 */
function initTripLikeButtons() {
    const likeBtns = document.querySelectorAll('.js-trip-like-btn');

    likeBtns.forEach(btn => {
        btn.addEventListener('click', async function (e) {
            e.preventDefault();
            e.stopPropagation();

            const tripId = this.dataset.tripId;
            const icon = this.querySelector('i');

            try {
                const response = await fetch(`/api/trip/${tripId}/like`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (data.status === 'success') {
                    // Update button state
                    if (data.liked) {
                        this.classList.add('liked');
                        icon.classList.remove('bi-heart');
                        icon.classList.add('bi-heart-fill');
                        this.title = 'Unlike';
                    } else {
                        this.classList.remove('liked');
                        icon.classList.remove('bi-heart-fill');
                        icon.classList.add('bi-heart');
                        this.title = 'Like this trip';
                    }

                    // Update likes count display if exists
                    const card = this.closest('.route-card');
                    if (card) {
                        const likesDisplay = card.querySelector('.likes-display span');
                        if (likesDisplay) {
                            likesDisplay.textContent = data.likes_count;
                        } else if (data.likes_count > 0) {
                            // If likes display doesn't exist but likes_count > 0, create it dynamically
                            const tripStats = card.querySelector('.trip-stats');
                            if (tripStats) {
                                const likesDiv = document.createElement('div');
                                likesDiv.className = 'likes-display';
                                likesDiv.style.cssText = 'display: flex; align-items: center; gap: 0.25rem;';
                                likesDiv.innerHTML = `
                                    <i class="bi bi-heart-fill" style="color: var(--error);"></i>
                                    <span>${data.likes_count}</span>
                                `;
                                tripStats.appendChild(likesDiv);
                            }
                        }
                    }

                    if (typeof showToast === 'function') {
                        showToast(data.message, 'success');
                    }
                }
            } catch (error) {
                console.error('Error liking trip:', error);
                if (typeof showToast === 'function') {
                    showToast('Failed to update like status', 'error');
                }
            }
        });
    });
}

/**
 * Trip Favorite Button Handler
 */
function initTripFavoriteButtons() {
    const favBtns = document.querySelectorAll('.js-trip-favorite-btn');

    favBtns.forEach(btn => {
        btn.addEventListener('click', async function (e) {
            e.preventDefault();
            e.stopPropagation();

            const tripId = this.dataset.tripId;
            const icon = this.querySelector('i');

            try {
                const response = await fetch(`/api/trip/${tripId}/favorite`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (data.status === 'success') {
                    // Update button state
                    if (data.favorited) {
                        this.classList.add('favorited');
                        icon.classList.remove('bi-bookmark');
                        icon.classList.add('bi-bookmark-fill');
                        this.title = 'Remove from favorites';
                    } else {
                        this.classList.remove('favorited');
                        icon.classList.remove('bi-bookmark-fill');
                        icon.classList.add('bi-bookmark');
                        this.title = 'Save to favorites';
                    }

                    if (typeof showToast === 'function') {
                        showToast(data.message, 'success');
                    }
                }
            } catch (error) {
                console.error('Error favoriting trip:', error);
                if (typeof showToast === 'function') {
                    showToast('Failed to update favorite status', 'error');
                }
            }
        });
    });
}

/**
 * Trip Review Edit Modal Handler
 */
function initTripReviewEditModal() {
    const editBtns = document.querySelectorAll('.js-edit-trip-review-btn');
    const modal = document.getElementById('edit-trip-review-modal');
    const closeBtn = document.getElementById('close-edit-trip-review-modal');
    const cancelBtn = document.getElementById('cancel-edit-trip-review');
    const form = document.getElementById('edit-trip-review-form');

    if (!modal || !form) return; // Exit if elements don't exist

    let currentReviewId = null;

    // Open edit modal
    editBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            currentReviewId = this.dataset.id;
            const rating = this.dataset.rating;
            const comment = this.dataset.comment || '';

            // Set form values
            const ratingInput = document.querySelector(`#edit-trip-star${rating}`);
            if (ratingInput) {
                ratingInput.checked = true;
            }

            const commentTextarea = document.getElementById('edit-trip-comment');
            if (commentTextarea) {
                commentTextarea.value = comment;
            }

            // Show modal
            modal.classList.add('active');
            modal.setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
        });
    });

    // Close modal function
    const closeModal = () => {
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        if (form) form.reset();
        currentReviewId = null;
    };

    // Close button handlers
    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeModal);
    }

    // Close on backdrop click
    modal.addEventListener('click', function (e) {
        if (e.target === modal || e.target.classList.contains('modal-backdrop')) {
            closeModal();
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
            closeModal();
        }
    });

    // Handle form submission
    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        if (!currentReviewId) {
            console.error('No review ID set');
            return;
        }

        const formData = new FormData(form);
        const rating = formData.get('rating');
        const comment = formData.get('comment') || '';

        if (!rating) {
            if (typeof showToast === 'function') {
                showToast('Please select a rating', 'error');
            }
            return;
        }

        try {
            const response = await fetch(`/api/trip_review/${currentReviewId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    rating: parseInt(rating),
                    comment: comment
                })
            });

            const data = await response.json();

            if (data.status === 'success') {
                if (typeof showToast === 'function') {
                    showToast('Review updated successfully!', 'success');
                }

                // Close modal
                closeModal();

                // Reload page to show updated review
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
            } else {
                if (typeof showToast === 'function') {
                    showToast(data.message || 'Failed to update review', 'error');
                }
            }
        } catch (error) {
            console.error('Error updating review:', error);
            if (typeof showToast === 'function') {
                showToast('An error occurred. Please try again.', 'error');
            }
        }
    });
}

/**
 * Initialize all trip interaction features
 */
function initTripInteractions() {
    // Initialize like buttons
    initTripLikeButtons();

    // Initialize favorite buttons
    initTripFavoriteButtons();

    // Initialize review edit modal
    initTripReviewEditModal();

    console.log('✓ Trip interactions initialized');
}

// Add to DOMContentLoaded event listener
document.addEventListener('DOMContentLoaded', function () {
    // Initialize trip interactions on community and route detail pages
    if (document.querySelector('.js-trip-like-btn') ||
        document.querySelector('.js-trip-favorite-btn') ||
        document.querySelector('.js-edit-trip-review-btn')) {
        initTripInteractions();
    }
});

// Expose functions to window object
if (typeof window !== 'undefined') {
    window.initTripLikeButtons = initTripLikeButtons;
    window.initTripFavoriteButtons = initTripFavoriteButtons;
    window.initTripReviewEditModal = initTripReviewEditModal;
    window.initTripInteractions = initTripInteractions;
}
// ===================================================================
// REVIEW DELETE FUNCTIONALITY - JavaScript
// ===================================================================

/**
 * Custom Confirmation Dialog
 * Provides a better UX than native browser confirm()
 */
window.showCustomConfirm = function (title, message, type = 'warning') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('custom-confirm-dialog');
        const titleEl = document.getElementById('custom-confirm-title');
        const messageEl = document.getElementById('custom-confirm-message');
        const iconEl = document.getElementById('custom-confirm-icon');
        const cancelBtn = document.getElementById('custom-confirm-cancel');
        const okBtn = document.getElementById('custom-confirm-ok');

        if (!overlay) {
            // Fallback to native confirm if dialog doesn't exist
            resolve(confirm(message));
            return;
        }

        // Set content
        titleEl.textContent = title;
        messageEl.textContent = message;

        // Set icon type
        iconEl.className = 'custom-confirm-icon ' + type;

        // Update icon
        const iconMap = {
            'warning': 'bi-exclamation-triangle-fill',
            'danger': 'bi-x-circle-fill',
            'info': 'bi-info-circle-fill'
        };
        iconEl.querySelector('i').className = 'bi ' + (iconMap[type] || iconMap.warning);

        // Show dialog
        overlay.style.display = 'flex';

        // Handle cancel
        const handleCancel = () => {
            overlay.style.display = 'none';
            cleanup();
            resolve(false);
        };

        // Handle confirm
        const handleOk = () => {
            overlay.style.display = 'none';
            cleanup();
            resolve(true);
        };

        // Cleanup event listeners
        const cleanup = () => {
            cancelBtn.removeEventListener('click', handleCancel);
            okBtn.removeEventListener('click', handleOk);
            overlay.removeEventListener('click', handleOverlayClick);
            document.removeEventListener('keydown', handleEscape);
        };

        // Click background to close
        const handleOverlayClick = (e) => {
            if (e.target === overlay) {
                handleCancel();
            }
        };

        // ESC key to close
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };

        // Bind events
        cancelBtn.addEventListener('click', handleCancel);
        okBtn.addEventListener('click', handleOk);
        overlay.addEventListener('click', handleOverlayClick);
        document.addEventListener('keydown', handleEscape);

        // Focus confirm button
        setTimeout(() => okBtn.focus(), 100);
    });
};

/**
 * Initialize Delete Review Buttons
 */
function initDeleteReviewButtons() {
    const deleteButtons = document.querySelectorAll('.js-delete-review-btn');

    deleteButtons.forEach(button => {
        button.addEventListener('click', async function () {
            const reviewId = this.dataset.id;
            const reviewType = this.dataset.type; // 'destination' or 'trip'
            const reviewCardId = reviewType === 'trip' ? `trip-review-${reviewId}` : `review-${reviewId}`;
            const reviewCard = document.getElementById(reviewCardId);

            // Show confirmation dialog
            const confirmed = await (typeof window.showCustomConfirm === 'function'
                ? window.showCustomConfirm(
                    'Confirm Delete',
                    'Are you sure you want to delete this review? This action cannot be undone.',
                    'warning'
                )
                : confirm('Are you sure you want to delete this review? This action cannot be undone.')
            );

            if (!confirmed) return;

            // Show deleting state
            if (reviewCard) {
                reviewCard.classList.add('deleting');
            }

            try {
                const endpoint = reviewType === 'trip'
                    ? `/api/trip_review/${reviewId}/delete`
                    : `/api/review/${reviewId}/delete`;

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (data.status === 'success') {
                    // Show success message
                    let message = 'Review deleted successfully';
                    if (data.deleted_by === 'trip_author') {
                        message = 'Review deleted (as trip author)';
                    } else if (data.deleted_by === 'admin') {
                        message = 'Review deleted (admin action)';
                    }

                    if (typeof showToast === 'function') {
                        showToast(message, 'success');
                    }

                    // Animate removal
                    if (reviewCard) {
                        reviewCard.classList.remove('deleting');
                        reviewCard.classList.add('deleted');
                    }

                    // Reload page after animation
                    setTimeout(() => {
                        window.location.reload();
                    }, 500);
                } else {
                    // Show error message
                    if (reviewCard) {
                        reviewCard.classList.remove('deleting');
                    }

                    if (typeof showToast === 'function') {
                        showToast(data.message || 'Failed to delete review', 'error');
                    } else {
                        alert(data.message || 'Failed to delete review');
                    }
                }
            } catch (error) {
                console.error('Delete review error:', error);

                if (reviewCard) {
                    reviewCard.classList.remove('deleting');
                }

                if (typeof showToast === 'function') {
                    showToast('Failed to delete review. Please try again.', 'error');
                } else {
                    alert('Failed to delete review. Please try again.');
                }
            }
        });
    });
}

// Initialize delete buttons when DOM is ready
document.addEventListener('DOMContentLoaded', function () {
    // Check if we're on a page with reviews
    if (document.querySelector('.js-delete-review-btn')) {
        initDeleteReviewButtons();
        console.log('✓ Delete review buttons initialized');
    }
});

// Expose function to window object
if (typeof window !== 'undefined') {
    window.initDeleteReviewButtons = initDeleteReviewButtons;
}

// ===================================================================
// ADMIN PANEL - JavaScript Functions
// ===================================================================

/**
 * Admin Table - Select All Functionality
 */
function initAdminSelectAll() {
    const selectAllCheckbox = document.getElementById('select-all');
    if (!selectAllCheckbox) return;

    selectAllCheckbox.addEventListener('change', function () {
        const checkboxes = document.querySelectorAll('.user-checkbox, .trip-checkbox');
        checkboxes.forEach(cb => cb.checked = this.checked);
        updateBulkActionsBar();
    });
}

/**
 * Update Bulk Actions Bar
 */
function updateBulkActionsBar() {
    const checked = document.querySelectorAll('.user-checkbox:checked, .trip-checkbox:checked');
    const bar = document.getElementById('bulk-actions-bar');
    const count = document.getElementById('selected-count');

    if (!bar || !count) return;

    if (checked.length > 0) {
        bar.classList.add('show');
        count.textContent = `${checked.length} selected`;
    } else {
        bar.classList.remove('show');
    }
}


/**
 * Admin Trip Actions
 */
async function togglePublic(tripId) {
    try {
        const response = await fetch(`/admin_trips/${tripId}/toggle-public`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.status === 'success') {
            if (typeof showToast === 'function') {
                showToast(data.message, 'success');
            }
            setTimeout(() => location.reload(), 1000);
        }
    } catch (error) {
        console.error('Toggle public error:', error);
        if (typeof showToast === 'function') {
            showToast('An error occurred', 'error');
        }
    }
}

async function toggleFeatured(tripId) {
    try {
        const response = await fetch(`/admin_trips/${tripId}/toggle-featured`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.status === 'success') {
            if (typeof showToast === 'function') {
                showToast(data.message, 'success');
            }
            setTimeout(() => location.reload(), 1000);
        }
    } catch (error) {
        console.error('Toggle featured error:', error);
        if (typeof showToast === 'function') {
            showToast('An error occurred', 'error');
        }
    }
}

async function deleteTrip(tripId, title) {
    if (!confirm(`Delete trip "${title}"? This cannot be undone.`)) return;

    try {
        const response = await fetch(`/admin_trips/${tripId}/delete`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.status === 'success') {
            if (typeof showToast === 'function') {
                showToast(data.message, 'success');
            }
            setTimeout(() => location.reload(), 1000);
        }
    } catch (error) {
        console.error('Delete trip error:', error);
        if (typeof showToast === 'function') {
            showToast('An error occurred', 'error');
        }
    }
}

/**
 * Bulk Actions
 */
async function bulkAction(action) {
    try {
        const tripCheckboxes = document.querySelectorAll('.trip-checkbox:checked');

        let checkedIds = [];
        let endpoint = '';

        if (tripCheckboxes.length > 0) {
            checkedIds = Array.from(tripCheckboxes).map(cb => parseInt(cb.value));
            endpoint = '/admin_trips/bulk-action';
        }

        if (checkedIds.length === 0) {
            if (typeof showToast === 'function') {
                showToast('Please select at least one item', 'error');
            } else {
                alert('Please select at least one item');
            }
            return;
        }

        const actionText = action === 'delete' ? 'delete' :
            action === 'make_public' ? 'make public' : 'make private';

        if (!confirm(`Are you sure you want to ${actionText} ${checkedIds.length} item(s)?`)) return;

        const body = { action, trip_ids: checkedIds };

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (typeof showToast === 'function') {
            showToast(data.message, data.status === 'success' ? 'success' : 'error');
        } else {
            alert(data.message);
        }

        if (data.status === 'success') {
            setTimeout(() => location.reload(), 1000);
        }
    } catch (error) {
        console.error('Bulk action error:', error);
        if (typeof showToast === 'function') {
            showToast('An error occurred', 'error');
        }
    }
}

/**
 * Initialize Admin Panel
 */
function initAdminPanel() {
    // Initialize select all functionality
    initAdminSelectAll();

    // Initialize individual checkboxes
    const checkboxes = document.querySelectorAll('.trip-checkbox');
    checkboxes.forEach(cb => {
        cb.addEventListener('change', updateBulkActionsBar);
    });

    console.log('✓ Admin panel initialized');
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', function () {
    // Check if we're on an admin page
    if (document.querySelector('.admin-layout')) {
        initAdminPanel();
    }
});

// Expose admin functions to window
if (typeof window !== 'undefined') {
    window.togglePublic = togglePublic;
    window.toggleFeatured = toggleFeatured;
    window.deleteTrip = deleteTrip;
    window.bulkAction = bulkAction;
    window.initAdminPanel = initAdminPanel;
}

// =========================================
// PROFILE PAGE - PASSWORD STRENGTH CHECKER
// =========================================

function initProfilePasswordStrength() {
    const newPasswordInput = document.getElementById('new_password');
    const confirmPasswordInput = document.getElementById('confirm_new_password');
    const strengthIndicator = document.getElementById('password-strength-profile');
    const strengthBarFill = document.getElementById('strength-bar-fill-profile');
    const strengthLabel = document.getElementById('strength-label-profile');
    const matchHint = document.getElementById('password-match-hint-profile');

    if (!newPasswordInput) return;

    // Show/hide strength indicator
    newPasswordInput.addEventListener('input', function () {
        const password = this.value;

        if (password.length === 0) {
            strengthIndicator.style.display = 'none';
            return;
        }

        strengthIndicator.style.display = 'block';

        // Check requirements
        const requirements = {
            length: password.length >= 8,
            uppercase: /[A-Z]/.test(password),
            lowercase: /[a-z]/.test(password),
            number: /\d/.test(password)
        };

        // Update requirement indicators
        updateRequirement('req-length-profile', requirements.length);
        updateRequirement('req-uppercase-profile', requirements.uppercase);
        updateRequirement('req-lowercase-profile', requirements.lowercase);
        updateRequirement('req-number-profile', requirements.number);

        // Calculate strength
        const metRequirements = Object.values(requirements).filter(Boolean).length;
        let strength = 'weak';
        let percentage = 25;

        if (metRequirements === 4) {
            strength = 'strong';
            percentage = 100;
        } else if (metRequirements === 3) {
            strength = 'good';
            percentage = 75;
        } else if (metRequirements === 2) {
            strength = 'fair';
            percentage = 50;
        }

        // Update strength bar
        strengthBarFill.style.width = percentage + '%';
        strengthBarFill.className = 'strength-bar-fill strength-' + strength;
        strengthLabel.textContent = strength.charAt(0).toUpperCase() + strength.slice(1);
        strengthLabel.className = 'strength-' + strength;

        checkPasswordMatch();
    });

    // Check password match
    if (confirmPasswordInput) {
        confirmPasswordInput.addEventListener('input', checkPasswordMatch);
    }

    function updateRequirement(id, met) {
        const elem = document.getElementById(id);
        if (!elem) return;

        const icon = elem.querySelector('i');
        if (met) {
            elem.classList.add('met');
            icon.className = 'bi bi-check-circle-fill';
        } else {
            elem.classList.remove('met');
            icon.className = 'bi bi-x-circle';
        }
    }

    function checkPasswordMatch() {
        if (!confirmPasswordInput || !matchHint) return;

        const password = newPasswordInput.value;
        const confirm = confirmPasswordInput.value;

        if (confirm.length === 0) {
            matchHint.style.display = 'none';
            return;
        }

        matchHint.style.display = 'block';

        if (password === confirm) {
            matchHint.textContent = '✓ Passwords match';
            matchHint.style.color = 'var(--success)';
        } else {
            matchHint.textContent = '✗ Passwords do not match';
            matchHint.style.color = 'var(--error)';
        }
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', function () {
    // Initialize profile page features if on profile page
    if (document.getElementById('new_password')) {
        initProfilePasswordStrength();
    }
});

// =========================================
// PROFILE PAGE - DELETE AND UNFAVORITE
// =========================================

// Delete My Generated Trip
document.addEventListener('click', function (e) {
    if (e.target.closest('.js-delete-trip')) {
        e.preventDefault();
        const btn = e.target.closest('.js-delete-trip');
        const tripId = btn.dataset.tripId;
        const tripItem = btn.closest('.trip-item');

        showCustomConfirm(
            'Delete Trip',
            'Are you sure you want to delete this trip? This action cannot be undone.',
            'danger'
        ).then(async (confirmed) => {
            if (!confirmed) return;

            try {
                const response = await fetch(`/api/trips/${tripId}`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (data.status === 'success') {
                    // Fade out and remove
                    tripItem.style.opacity = '0';
                    tripItem.style.transform = 'translateX(-20px)';
                    setTimeout(() => {
                        tripItem.remove();

                        // Check if list is now empty
                        const tripList = document.querySelector('.trip-list');
                        if (tripList && tripList.querySelectorAll('.trip-item').length === 0) {
                            tripList.innerHTML = '<p class="profile-empty-state">You haven\'t created any trips yet.</p>';
                        }
                    }, 300);

                    showToast('Trip deleted successfully', 'success');
                } else {
                    showToast('Failed to delete trip', 'error');
                }
            } catch (error) {
                console.error('Error deleting trip:', error);
                showToast('An error occurred', 'error');
            }
        });
    }

    // Unfavorite Trip
    if (e.target.closest('.js-unfavorite-trip')) {
        e.preventDefault();
        const btn = e.target.closest('.js-unfavorite-trip');
        const tripId = btn.dataset.tripId;
        const card = btn.closest('[data-favorite-trip-id]');

        showCustomConfirm(
            'Remove from Favorites',
            'Are you sure you want to remove this route from your favorites?',
            'warning'
        ).then(async (confirmed) => {
            if (!confirmed) return;

            try {
                const response = await fetch(`/api/trip/${tripId}/favorite`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (data.status === 'success' && !data.favorited) {
                    // Fade out and remove
                    card.style.opacity = '0';
                    card.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        card.remove();

                        // Check if grid is now empty
                        const grid = card.closest('.grid-2');
                        if (grid && grid.querySelectorAll('.route-card').length === 0) {
                            grid.innerHTML = '<p class="profile-no-favorites">No favorite routes yet.</p>';
                        }
                    }, 300);

                    showToast('Removed from favorites', 'success');
                } else {
                    showToast('Failed to update favorites', 'error');
                }
            } catch (error) {
                console.error('Error unfavoriting trip:', error);
                showToast('An error occurred', 'error');
            }
        });
    }

    // Unfavorite Destination
    if (e.target.closest('.js-unfavorite-destination')) {
        e.preventDefault();
        const btn = e.target.closest('.js-unfavorite-destination');
        const destId = btn.dataset.destinationId;
        const card = btn.closest('[data-destination-id]');

        showCustomConfirm(
            'Remove from Favorites',
            'Are you sure you want to remove this destination from your favorites?',
            'warning'
        ).then(async (confirmed) => {
            if (!confirmed) return;

            try {
                const response = await fetch(`/api/like/${destId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                const data = await response.json();

                if (data.status === 'success' && !data.liked) {
                    // Fade out and remove
                    card.style.opacity = '0';
                    card.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        card.remove();

                        // Check if grid is now empty
                        const grid = card.closest('.grid-2');
                        if (grid && grid.querySelectorAll('.route-card').length === 0) {
                            grid.innerHTML = '<p class="profile-no-favorites">No favorites yet.</p>';
                        }
                    }, 300);

                    showToast('Removed from favorites', 'success');
                } else {
                    showToast('Failed to update favorites', 'error');
                }
            } catch (error) {
                console.error('Error unfavoriting destination:', error);
                showToast('An error occurred', 'error');
            }
        });
    }
});
/* =========================================
   21. TRIP EDITOR - Load Trip Data from Route Detail Page
   ========================================= */

/**
 * Trip Editor Module
 * Handles loading trip data from route_detail page to planner page
 */
class TripEditor {
    constructor() {
        this.initialized = false;
    }

    /**
     * Check if there's trip data to load from localStorage when page loads
     * This happens when user clicks "Edit in Planner" from route_detail page
     */
    loadTripDataForEditing() {
        // Check URL parameters for edit mode
        const urlParams = new URLSearchParams(window.location.search);
        const editTripId = urlParams.get('edit');

        if (!editTripId) {
            return false; // Not in edit mode
        }

        // Try to load trip data from localStorage
        const storedTripData = localStorage.getItem('editTripData');
        const storedTripId = localStorage.getItem('editTripId');

        if (!storedTripData || storedTripId !== editTripId) {
            console.warn('[Trip Editor] No trip data found in localStorage for trip ID:', editTripId);
            return false;
        }

        try {
            const tripData = JSON.parse(storedTripData);
            console.log('[Trip Editor] Loading trip data:', tripData);

            // Clear localStorage after reading
            localStorage.removeItem('editTripData');
            localStorage.removeItem('editTripId');

            return tripData;
        } catch (error) {
            console.error('[Trip Editor] Error parsing trip data:', error);
            localStorage.removeItem('editTripData');
            localStorage.removeItem('editTripId');
            return false;
        }
    }

    /**
     * Apply loaded trip data to the planner interface
     * @param {Object} tripData - The trip data object from route_detail
     * @param {Object} planner - The TripPlanner instance
     */
    applyTripDataToPlanner(tripData, planner) {
        if (!tripData || !planner) {
            console.error('[Trip Editor] Invalid trip data or planner instance');
            return;
        }

        console.log('[Trip Editor] Applying trip data to planner...');

        try {
            // 1. Set trip name
            const tripNameInput = document.getElementById('trip-name');
            if (tripNameInput && tripData.name) {
                tripNameInput.value = tripData.name;
            }

            // 2. Set transport mode
            if (tripData.transport_mode) {
                const modeButtons = document.querySelectorAll('.transport-mode-btn');
                modeButtons.forEach(btn => {
                    const mode = btn.dataset.mode;
                    if (mode === tripData.transport_mode) {
                        btn.classList.add('active');
                        btn.setAttribute('aria-pressed', 'true');
                        // Update planner's transport mode
                        if (planner.state && planner.state.transportMode !== undefined) {
                            planner.state.transportMode = mode;
                        }
                    } else {
                        btn.classList.remove('active');
                        btn.setAttribute('aria-pressed', 'false');
                    }
                });
            }

            // 3. Clear existing route data
            if (planner.state) {
                // Clear days
                if (planner.state.days) {
                    planner.state.days = [];
                }

                // Clear markers
                if (planner.state.markers) {
                    planner.state.markers.forEach(marker => {
                        if (planner.state.map) {
                            planner.state.map.removeLayer(marker);
                        }
                    });
                    planner.state.markers = [];
                }

                // Clear polylines
                if (planner.state.polylines) {
                    planner.state.polylines.forEach(line => {
                        if (planner.state.map) {
                            planner.state.map.removeLayer(line);
                        }
                    });
                    planner.state.polylines = [];
                }
            }

            // 4. Load days and stops
            if (tripData.days && Array.isArray(tripData.days)) {
                console.log(`[Trip Editor] Loading ${tripData.days.length} days...`);

                // Sort days by number
                const sortedDays = [...tripData.days].sort((a, b) => a.number - b.number);

                // Process each day
                sortedDays.forEach((day, dayIndex) => {
                    console.log(`[Trip Editor] Processing Day ${day.number}:`, day);

                    // Create a new day in planner
                    if (planner.createDay && typeof planner.createDay === 'function') {
                        const newDay = planner.createDay(day.number);
                        if (planner.state && planner.state.days) {
                            // Set the first day as active
                            newDay.active = (dayIndex === 0);
                            planner.state.days.push(newDay);
                        }
                    }

                    if (day.stops && Array.isArray(day.stops)) {
                        day.stops.forEach((stop, stopIndex) => {
                            // Get coordinates
                            const lat = stop.lat || stop.latitude;
                            const lon = stop.lon || stop.longitude;

                            // Ensure lat/lon exist
                            if (!lat || !lon) {
                                console.warn('[Trip Editor] Stop missing coordinates, skipping:', stop);
                                return;
                            }

                            // Prepare location name
                            const locationName = stop.name || 'Unnamed Stop';
                            const fullName = stop.address ? `${locationName}, ${stop.address}` : locationName;

                            console.log(`[Trip Editor] Adding stop ${stopIndex + 1}: ${locationName}`);

                            // Create stop object matching TripPlanner's format
                            const stopObj = {
                                id: Date.now() + stopIndex + dayIndex * 1000,
                                name: locationName,
                                fullName: fullName,
                                lat: parseFloat(lat),
                                lon: parseFloat(lon),
                                type: stop.type || 'attraction',
                                arrival: stop.arrival || '',
                                duration: stop.duration || 1,
                                notes: stop.description || stop.notes || '',
                                budget: stop.budget || 0,
                                dayId: planner.state.days[dayIndex] ? planner.state.days[dayIndex].id : null
                            };

                            // Add to the corresponding day
                            if (planner.state && planner.state.days && planner.state.days[dayIndex]) {
                                planner.state.days[dayIndex].stops.push(stopObj);
                            }
                        });
                    }
                });

                // 5. Recalculate routes and update UI
                console.log('[Trip Editor] Recalculating routes...');

                if (planner.calculateRoutes && typeof planner.calculateRoutes === 'function') {
                    setTimeout(() => {
                        planner.calculateRoutes().then(() => {
                            console.log('[Trip Editor] Routes calculated successfully');

                            // Fit map to show all markers
                            if (planner.state && planner.state.map && planner.state.markers.length > 0) {
                                const bounds = L.latLngBounds(
                                    planner.state.markers.map(m => m.getLatLng())
                                );
                                planner.state.map.fitBounds(bounds, { padding: [50, 50] });
                            }
                        }).catch(error => {
                            console.error('[Trip Editor] Error calculating routes:', error);
                        });
                    }, 500);
                }

                // 6. Update stats
                if (planner.updateStats && typeof planner.updateStats === 'function') {
                    setTimeout(() => {
                        planner.updateStats();
                    }, 800);
                }

                // 7. Render days in UI
                if (planner.renderDays && typeof planner.renderDays === 'function') {
                    setTimeout(() => {
                        planner.renderDays();
                    }, 300);
                }

                console.log('[Trip Editor] Trip data successfully loaded!');

                // Show success message
                if (typeof showToast === 'function') {
                    setTimeout(() => {
                        showToast('Trip loaded successfully! You can now edit it.', 'success');
                    }, 1000);
                }
            } else {
                console.warn('[Trip Editor] No days data found in trip');
            }
        } catch (error) {
            console.error('[Trip Editor] Error applying trip data:', error);
            if (typeof showToast === 'function') {
                showToast('Error loading trip data. Please try again.', 'error');
            }
        }
    }

    /**
     * Initialize trip editor when DOM is ready
     * This should be called after TripPlanner is initialized
     */
    initialize() {
        if (this.initialized) return;

        // Wait for planner to be fully initialized
        let attempts = 0;
        const maxAttempts = 20; // 10 seconds max wait

        const checkPlanner = setInterval(() => {
            attempts++;

            // Check if planner is available
            const planner = window.planner || window.tripPlanner;

            if (planner && planner.state) {
                console.log('[Trip Editor] TripPlanner instance found');
                clearInterval(checkPlanner);
                this.initialized = true;

                // Check if there's trip data to load
                const tripData = this.loadTripDataForEditing();

                if (tripData) {
                    console.log('[Trip Editor] Trip edit mode activated');

                    // Wait a bit more for map to be ready
                    setTimeout(() => {
                        this.applyTripDataToPlanner(tripData, planner);
                    }, 500);
                } else {
                    console.log('[Trip Editor] No trip data to load (normal planner mode)');
                }
            } else if (attempts >= maxAttempts) {
                console.warn('[Trip Editor] TripPlanner instance not found after', maxAttempts * 500, 'ms');
                clearInterval(checkPlanner);
            }
        }, 500);
    }
}

/* =========================================
   22. ROUTE DETAIL PAGE - Edit in Planner Functionality
   ========================================= */

/**
 * Function to edit trip in planner - stores trip data in localStorage and redirects
 * Called from route_detail.html when user clicks "Edit in Planner" button
 * @param {number} tripId - The ID of the trip to edit
 */
function editTripInPlanner(tripId) {
    if (window.featuredRouteTripData) {
        // Store trip data in localStorage for planner page to retrieve
        localStorage.setItem('editTripData', JSON.stringify(window.featuredRouteTripData));
        localStorage.setItem('editTripId', tripId.toString());

        console.log('[Route Detail] Storing trip data for editing:', window.featuredRouteTripData);

        // Redirect to planner page
        window.location.href = '/planner?edit=' + tripId;
    } else {
        console.error('[Route Detail] Trip data not available');
        alert('Unable to load trip data. Please try again.');
    }
}

/* =========================================
   SHARE FUNCTIONALITY
   ========================================= */

/**
 * Share Modal Functionality
 * Handles opening/closing the share modal and social sharing
 */
(function initShareFunctionality() {
    'use strict';

    const shareBtn = document.querySelector('.js-share-btn');
    const shareModal = document.getElementById('share-modal');

    // Exit if required elements don't exist
    if (!shareBtn || !shareModal) {
        return;
    }

    const modalBackdrop = shareModal.querySelector('.modal-backdrop');
    const modalClose = shareModal.querySelector('.modal-close');
    const copyLinkBtn = shareModal.querySelector('.js-copy-link');
    const shareButtons = shareModal.querySelectorAll('.share-btn[data-share]');

    /**
     * Open share modal
     */
    function openShareModal() {
        shareModal.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Set focus to modal for accessibility
        modalClose?.focus();
    }

    /**
     * Close share modal
     */
    function closeShareModal() {
        shareModal.classList.remove('active');
        document.body.style.overflow = '';

        // Return focus to share button
        shareBtn?.focus();
    }

    // Event: Open modal on share button click
    shareBtn.addEventListener('click', openShareModal);

    // Event: Close modal on backdrop click
    if (modalBackdrop) {
        modalBackdrop.addEventListener('click', closeShareModal);
    }

    // Event: Close modal on close button click
    if (modalClose) {
        modalClose.addEventListener('click', closeShareModal);
    }

    // Event: Close modal on Escape key
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && shareModal.classList.contains('active')) {
            closeShareModal();
        }
    });

    /**
     * Handle social media sharing
     */
    if (shareButtons.length > 0) {
        shareButtons.forEach(btn => {
            btn.addEventListener('click', function () {
                const shareType = this.getAttribute('data-share');
                const url = encodeURIComponent(window.location.href);
                const title = encodeURIComponent(document.title);
                const description = document.querySelector('meta[name="description"]')?.content || '';
                const encodedDesc = encodeURIComponent(description);

                let shareUrl = '';
                const windowFeatures = 'width=600,height=400,left=200,top=100';

                switch (shareType) {
                    case 'facebook':
                        shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${url}`;
                        break;
                    case 'twitter':
                        shareUrl = `https://twitter.com/intent/tweet?url=${url}&text=${title}`;
                        break;
                    case 'email':
                        const emailSubject = title;
                        const emailBody = `Check out this amazing destination!

${decodeURIComponent(title)}

${description}

Visit: ${window.location.href}

Shared via Voyager`;
                        shareUrl = `mailto:?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;
                        break;
                    case 'linkedin':
                        shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${url}`;
                        break;
                    case 'whatsapp':
                        shareUrl = `https://wa.me/?text=${title}%20${url}`;
                        break;
                }

                if (shareUrl) {
                    if (shareType === 'email') {
                        // Email opens in default mail client
                        window.location.href = shareUrl;
                    } else {
                        // Social media opens in popup
                        window.open(shareUrl, 'share-dialog', windowFeatures);
                    }
                    closeShareModal();
                }
            });
        });
    }

    /**
     * Copy link to clipboard
     */
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', async function () {
            const url = window.location.href;

            try {
                // Modern Clipboard API
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(url);

                    // Show success feedback
                    if (typeof showToast === 'function') {
                        showToast('✓ Link copied to clipboard!', 'success');
                    } else {
                        alert('Link copied to clipboard!');
                    }
                } else {
                    // Fallback for older browsers
                    const textArea = document.createElement('textarea');
                    textArea.value = url;
                    textArea.style.position = 'fixed';
                    textArea.style.left = '-999999px';
                    textArea.style.top = '-999999px';
                    textArea.setAttribute('readonly', '');
                    document.body.appendChild(textArea);

                    // Select and copy
                    textArea.select();
                    textArea.setSelectionRange(0, 99999); // For mobile devices

                    const successful = document.execCommand('copy');
                    document.body.removeChild(textArea);

                    if (successful) {
                        if (typeof showToast === 'function') {
                            showToast('✓ Link copied to clipboard!', 'success');
                        } else {
                            alert('Link copied to clipboard!');
                        }
                    } else {
                        throw new Error('Copy command failed');
                    }
                }

                closeShareModal();

            } catch (err) {
                console.error('Copy to clipboard failed:', err);

                // Show error feedback
                if (typeof showToast === 'function') {
                    showToast('Failed to copy. Please copy the URL manually.', 'error');
                } else {
                    alert('Failed to copy link. Please copy manually: ' + url);
                }
            }
        });
    }

    // Log initialization
    console.log('[Share Module] Initialized successfully');

})();

/* =========================================
   TABS FUNCTIONALITY FIX
   Add this to the end of script.js or as a separate file
   ========================================= */

/**
 * Enhanced Tab Switcher with Debugging
 * This provides a backup/enhanced implementation for tab switching
 */
(function initEnhancedTabs() {
    'use strict';

    // Wait for DOM to be fully loaded
    function initialize() {
        const tabButtons = document.querySelectorAll('.tab-btn');
        const tabPanels = document.querySelectorAll('.tab-panel');

        // Debug logging
        console.log('[Tabs] Found', tabButtons.length, 'tab buttons');
        console.log('[Tabs] Found', tabPanels.length, 'tab panels');

        // Exit if no tabs found
        if (tabButtons.length === 0 || tabPanels.length === 0) {
            console.warn('[Tabs] No tabs found on this page');
            return;
        }

        /**
         * Switch to a specific tab
         * @param {string} tabId - The data-tab value to switch to
         */
        function switchTab(tabId) {
            console.log('[Tabs] Switching to tab:', tabId);

            // Deactivate all buttons
            tabButtons.forEach(btn => {
                btn.classList.remove('active');
                btn.setAttribute('aria-selected', 'false');
            });

            // Deactivate all panels
            tabPanels.forEach(panel => {
                panel.classList.remove('active');
            });

            // Activate the target button
            const targetButton = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
            if (targetButton) {
                targetButton.classList.add('active');
                targetButton.setAttribute('aria-selected', 'true');
            } else {
                console.error('[Tabs] Button not found for tab:', tabId);
            }

            // Activate the target panel
            const targetPanel = document.querySelector(`.tab-panel[data-tab="${tabId}"]`);
            if (targetPanel) {
                targetPanel.classList.add('active');

                // Smooth scroll to tabs if needed (mobile)
                if (window.innerWidth <= 768) {
                    targetPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            } else {
                console.error('[Tabs] Panel not found for tab:', tabId);
            }
        }

        // Add click event to each tab button
        tabButtons.forEach((button, index) => {
            // Log button info
            const tabId = button.getAttribute('data-tab');
            console.log(`[Tabs] Setting up button ${index + 1}:`, tabId);

            // Remove any existing listeners by cloning
            const newButton = button.cloneNode(true);
            button.parentNode.replaceChild(newButton, button);

            // Add click event
            newButton.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();

                const targetTabId = this.getAttribute('data-tab');
                console.log('[Tabs] Button clicked:', targetTabId);
                switchTab(targetTabId);
            });

            // Also handle keyboard navigation
            newButton.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const targetTabId = this.getAttribute('data-tab');
                    switchTab(targetTabId);
                }
            });
        });

        // Support for hash-based navigation (optional)
        // e.g., #tab-getting-there
        function handleHashChange() {
            const hash = window.location.hash.slice(1); // Remove #
            if (hash.startsWith('tab-')) {
                const tabId = hash.replace('tab-', '');
                switchTab(tabId);
            }
        }

        // Check hash on load
        if (window.location.hash) {
            setTimeout(handleHashChange, 100);
        }

        // Listen for hash changes
        window.addEventListener('hashchange', handleHashChange);

        console.log('[Tabs] Enhanced tab system initialized successfully');
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        // DOM is already loaded
        initialize();
    }

})();

/**
 * Alternative: Direct initialization without IIFE
 * Use this if the above doesn't work
 */
window.initTabsDirectly = function () {
    console.log('[Tabs] Direct initialization called');

    const tabButtons = document.querySelectorAll('.tab-btn');
    if (tabButtons.length === 0) {
        console.error('[Tabs] No tab buttons found!');
        return;
    }

    tabButtons.forEach(button => {
        button.addEventListener('click', function () {
            const tabId = this.getAttribute('data-tab');
            console.log('[Tabs] Switching to:', tabId);

            // Remove active from all buttons
            document.querySelectorAll('.tab-btn').forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });

            // Remove active from all panels
            document.querySelectorAll('.tab-panel').forEach(p => {
                p.classList.remove('active');
            });

            // Add active to clicked button
            this.classList.add('active');
            this.setAttribute('aria-selected', 'true');

            // Add active to corresponding panel
            const panel = document.querySelector(`.tab-panel[data-tab="${tabId}"]`);
            if (panel) {
                panel.classList.add('active');
            }
        });
    });

    console.log('[Tabs] Direct initialization complete');
};

// Auto-call direct init after a delay as fallback
setTimeout(function () {
    // Only run if tabs exist but aren't working
    const firstButton = document.querySelector('.tab-btn');
    if (firstButton && !firstButton.__tabsInitialized) {
        console.log('[Tabs] Running fallback initialization');
        window.initTabsDirectly();
    }
}, 2000);

/**
 * Optional: Native Web Share API Support
 * Modern browsers support native sharing
 */
(function enhanceShareWithNativeAPI() {
    'use strict';

    const shareBtn = document.querySelector('.js-share-btn');

    if (!shareBtn) return;

    // Check if Web Share API is supported
    if (navigator.share) {
        // Add a native share option to the share button
        shareBtn.addEventListener('click', async function (e) {
            // Check if user is holding Shift key for native share
            if (e.shiftKey) {
                e.stopImmediatePropagation();

                const shareData = {
                    title: document.title,
                    text: document.querySelector('meta[name="description"]')?.content || '',
                    url: window.location.href
                };

                try {
                    await navigator.share(shareData);
                    console.log('[Share] Shared successfully via native API');
                } catch (err) {
                    // User cancelled or error occurred
                    if (err.name !== 'AbortError') {
                        console.error('[Share] Native share failed:', err);
                    }
                }
            }
        });

        // Add tooltip hint
        shareBtn.setAttribute('title', 'Click to share | Shift+Click for native share');
    }
})();

// Make function available globally
window.editTripInPlanner = editTripInPlanner;

/* =========================================
   23. INITIALIZATION - Trip Editor for Planner Page
   ========================================= */

// Initialize Trip Editor when on planner page
if (document.getElementById('map')) {
    document.addEventListener('DOMContentLoaded', () => {
        const tripEditor = new TripEditor();

        // Wait a bit for TripPlanner to initialize first
        setTimeout(() => {
            tripEditor.initialize();
        }, 1000);
    });
}

/* =========================================
   24. ADMIN PANEL FUNCTIONS
   ========================================= */

/**
 * Admin Destinations - Delete destination
 */
function adminDeleteDest(id) {
    if (!confirm('Delete this destination?')) return;
    fetch(`/admin_destinations/${id}/delete`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                if (typeof showToast === 'function') {
                    showToast('Destination deleted successfully', 'success');
                }
                setTimeout(() => location.reload(), 1000);
            } else {
                alert(data.message);
            }
        })
        .catch(error => {
            console.error('Delete destination error:', error);
            alert('An error occurred while deleting the destination');
        });
}

/**
 * Admin Reviews - Delete review
 */
function deleteAdminReview(id) {
    if (!confirm('Permanently delete this review?')) return;
    fetch(`/api/review/${id}/delete`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                if (typeof showToast === 'function') {
                    showToast('Review deleted successfully', 'success');
                }
                setTimeout(() => location.reload(), 1000);
            } else {
                alert('Error: ' + data.message);
            }
        })
        .catch(error => {
            console.error('Delete review error:', error);
            alert('An error occurred while deleting the review');
        });
}

/**
 * Admin Dashboard - Initialize trip chart
 */
function initAdminDashboardChart() {
    const tripChartCanvas = document.getElementById('tripChart');
    if (!tripChartCanvas) return;

    // Get data from data attributes
    const chartData = tripChartCanvas.dataset.chartData;
    if (!chartData) {
        console.error('No chart data found');
        return;
    }

    try {
        const data = JSON.parse(chartData);

        const tripCtx = tripChartCanvas.getContext('2d');
        const tripChart = new Chart(tripCtx, {
            type: 'bar',
            data: {
                labels: data.dates,
                datasets: [{
                    label: 'New Trips',
                    data: data.new_trips,
                    backgroundColor: '#22c55e',
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            precision: 0
                        }
                    }
                }
            }
        });

        console.log('✓ Admin dashboard chart initialized');
    } catch (error) {
        console.error('Error initializing chart:', error);
    }
}

// Initialize admin dashboard chart on page load
document.addEventListener('DOMContentLoaded', function () {
    if (document.querySelector('.admin-layout') && document.getElementById('tripChart')) {
        // Wait for Chart.js to load
        if (typeof Chart !== 'undefined') {
            initAdminDashboardChart();
        } else {
            console.error('Chart.js not loaded');
        }
    }
});

// Expose admin functions to window
if (typeof window !== 'undefined') {
    window.adminDeleteDest = adminDeleteDest;
    window.deleteAdminReview = deleteAdminReview;
    window.initAdminDashboardChart = initAdminDashboardChart;
}