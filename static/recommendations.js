class RecommendationsManager {
    constructor() {
        this.grid = document.getElementById('recommendations-grid');
        this.title = document.getElementById('rec-title');
        this.subtitle = document.getElementById('rec-subtitle');
        this.refreshBtn = document.getElementById('refresh-btn');
        this.isLoading = false;
        this.retryCount = 0;
        this.maxRetries = 3;

        // Initialize
        if (this.grid) {
            console.log('[REC] Initializing RecommendationsManager');
            this.init();
        } else {
            console.warn('[REC] Recommendations grid element not found - user may not be logged in');
        }
    }

    init() {
        console.log('[REC] Starting initialization');
        this.loadRecommendations();
        this.setupFavoritesListener();

        // Add refresh button listener
        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => {
                console.log('[REC] Manual refresh triggered');
                this.loadRecommendations();
            });
        }
    }

    async loadRecommendations() {
        if (this.isLoading) {
            console.log('[REC] Already loading, skipping...');
            return;
        }

        this.isLoading = true;
        this.showLoadingState();

        try {
            console.log('[REC] Fetching recommendations from /api/recommendations');
            const startTime = performance.now();

            const response = await fetch('/api/recommendations', {
                method: 'GET',
                credentials: 'same-origin',
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                }
            });

            const loadTime = performance.now() - startTime;
            console.log(`[REC] Response received in ${loadTime.toFixed(2)}ms`);
            console.log(`[REC] Status: ${response.status} ${response.statusText}`);

            if (!response.ok) {
                // Try to get error details
                let errorDetail = '';
                try {
                    const errorText = await response.text();
                    errorDetail = errorText.substring(0, 200);
                    console.error('[REC] Error response:', errorDetail);
                } catch (e) {
                    console.error('[REC] Could not read error response');
                }

                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Parse JSON response
            const data = await response.json();
            console.log('[REC] Data received:', {
                type: data.type,
                message: data.message,
                destinationCount: data.destinations?.length || 0
            });

            if (!data.destinations) {
                console.warn('[REC] Response missing destinations array');
                data.destinations = [];
            }

            this.displayRecommendations(data);
            this.retryCount = 0; // Reset retry counter on success

        } catch (error) {
            console.error('[REC] Error loading recommendations:', error);
            console.error('[REC] Error details:', {
                name: error.name,
                message: error.message,
                stack: error.stack
            });

            // Retry logic
            if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                console.log(`[REC] Retrying... (${this.retryCount}/${this.maxRetries})`);
                setTimeout(() => {
                    this.isLoading = false;
                    this.loadRecommendations();
                }, 2000 * this.retryCount); // Exponential backoff
            } else {
                this.showErrorState(error.message);
            }

        } finally {
            this.isLoading = false;
        }
    }

    showLoadingState() {
        console.log('[REC] Showing loading state');

        if (this.refreshBtn) {
            this.refreshBtn.disabled = true;
            const icon = this.refreshBtn.querySelector('i');
            if (icon) {
                icon.classList.add('spinning');
            }
        }

        this.grid.innerHTML = `
            <div class="loading-placeholder">
                <div class="spinner-container">
                    <div class="spinner"></div>
                </div>
                <p class="loading-text">Finding perfect destinations for you...</p>
            </div>
        `;
    }

    displayRecommendations(data) {
        console.log('[REC] Displaying recommendations');

        // Update header
        this.updateHeader(data);

        // Check if we have destinations
        if (!data.destinations || data.destinations.length === 0) {
            console.log('[REC] No destinations to display');
            this.showEmptyState(data.type);
            return;
        }

        console.log(`[REC] Rendering ${data.destinations.length} destination cards`);

        // Render cards
        this.renderRecommendationCards(data.destinations);

        // Re-enable refresh button
        if (this.refreshBtn) {
            this.refreshBtn.disabled = false;
            const icon = this.refreshBtn.querySelector('i');
            if (icon) {
                icon.classList.remove('spinning');
            }
        }

        // Bind like buttons
        this.initializeLikeButtons();

        console.log('[REC] Display complete');
    }

    updateHeader(data) {
        if (data.type === 'popular') {
            this.title.innerHTML = '<i class="bi bi-fire"></i> Popular Destinations';
            this.subtitle.textContent = data.message || 'Start saving destinations to get personalized recommendations!';
        } else if (data.type === 'error') {
            this.title.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Recommendations';
            this.subtitle.textContent = data.message || 'Having trouble loading recommendations';
        } else {
            this.title.innerHTML = '<i class="bi bi-stars"></i> Recommended for You';
            this.subtitle.textContent = data.message || 'Based on your preferences';
        }
    }

    renderRecommendationCards(destinations) {
        const cardsHTML = destinations.map(dest => this.createRecommendationCard(dest)).join('');
        this.grid.innerHTML = cardsHTML;
    }

    createRecommendationCard(dest) {

        return `
            <article class="route-card recommendation-card">
                <div class="card-image-wrapper">
                    <a href="/destination/${dest.id}">
                        <img src="${dest.image || '/static/img/placeholder.jpg'}" 
                             alt="${this.escapeHtml(dest.name)}" 
                             loading="lazy"
                             onerror="this.src='/static/img/placeholder.jpg'">
                    </a>
                    
                    <button class="btn-like js-like-btn js-rec-like ${dest.is_favorited ? 'liked' : ''}" 
                            data-id="${dest.id}" 
                            title="${dest.is_favorited ? 'Remove from favorites' : 'Add to favorites'}">
                        <i class="bi ${dest.is_favorited ? 'bi-heart-fill' : 'bi-heart'}"></i>
                    </button>
                    
                    <span class="rec-badge">
                        <i class="bi bi-stars"></i> Recommended
                    </span>
                </div>
                
                <div class="card-body">
                    <div class="card-meta">
                        <span><i class="bi bi-geo-alt"></i> ${this.escapeHtml(dest.city || 'Unknown')}</span>
                        <span><i class="bi bi-tag"></i> ${this.escapeHtml(dest.category || 'General')}</span>
                        <span><i class="bi bi-star-fill" style="color: #fbbf24;"></i> ${(dest.rating || 0).toFixed(1)}</span>
                    </div>
                    
                    <h3>
                        <a href="/destination/${dest.id}">${this.escapeHtml(dest.name)}</a>
                    </h3>

                    <p class="description">${this.escapeHtml(dest.desc || 'Explore this amazing destination')}</p>
                    
                    <div class="card-actions">
                        <button class="btn btn-card-action js-add-to-plan" 
                                data-id="${dest.id}" 
                                data-name="${this.escapeHtml(dest.name)}" 
                                data-lat="${dest.lat || ''}" 
                                data-lon="${dest.lon || ''}">
                            <i class="bi bi-plus-circle"></i> <span>Add to Plan</span>
                        </button>
                    </div>
                </div>
            </article>
        `;
    }
    generateStars(rating) {
        const fullStars = Math.floor(rating);
        const hasHalfStar = rating % 1 >= 0.5;
        const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);

        let starsHtml = '';
        for (let i = 0; i < fullStars; i++) {
            starsHtml += '<i class="bi bi-star-fill"></i>';
        }
        if (hasHalfStar) {
            starsHtml += '<i class="bi bi-star-half"></i>';
        }
        for (let i = 0; i < emptyStars; i++) {
            starsHtml += '<i class="bi bi-star"></i>';
        }

        return starsHtml;
    }

    generateReasons(reasons) {
        if (!reasons || reasons.length === 0) {
            return '';
        }

        const reasonsList = reasons.map(reason =>
            `<li>${this.escapeHtml(reason)}</li>`
        ).join('');

        return `
            <div class="rec-reasons">
                <div class="rec-reasons-title">
                    <i class="bi bi-lightbulb-fill"></i> Why this?
                </div>
                <ul class="rec-reasons-list">
                    ${reasonsList}
                </ul>
            </div>
        `;
    }

    showEmptyState(type) {
        const message = type === 'popular'
            ? 'Save some destinations to get personalized recommendations!'
            : 'We couldn\'t find any recommendations at this time. Try saving more destinations!';

        this.grid.innerHTML = `
            <div class="empty-state">
                <i class="bi bi-inbox"></i>
                <h3>No recommendations yet</h3>
                <p>${message}</p>
                <a href="/destinations" class="btn btn-outline">
                    Browse All Destinations
                </a>
            </div>
        `;

        if (this.refreshBtn) {
            this.refreshBtn.disabled = false;
            const icon = this.refreshBtn.querySelector('i');
            if (icon) icon.classList.remove('spinning');
        }
    }

    showErrorState(errorMsg) {
        console.error('[REC] Showing error state:', errorMsg);

        this.grid.innerHTML = `
            <div class="error-state">
                <i class="bi bi-exclamation-triangle"></i>
                <h3>Unable to Load Recommendations</h3>
                <p>${errorMsg || 'Please try again later.'}</p>
                <button class="btn btn-primary" onclick="window.recommendationsManager.loadRecommendations()">
                    <i class="bi bi-arrow-clockwise"></i> Retry
                </button>
            </div>
        `;

        if (this.refreshBtn) {
            this.refreshBtn.disabled = false;
            const icon = this.refreshBtn.querySelector('i');
            if (icon) icon.classList.remove('spinning');
        }
    }

    initializeLikeButtons() {
        const likeButtons = this.grid.querySelectorAll('.js-rec-like');
        console.log(`[REC] Initializing ${likeButtons.length} like buttons`);

        likeButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.handleLikeClick(btn);
            });
        });
    }

    async handleLikeClick(button) {
        const destId = button.dataset.id;
        const icon = button.querySelector('i');
        const isLiked = button.classList.contains('liked');
        const actionToPerform = isLiked ? 'unlike' : 'like';

        try {
            const response = await fetch(`/api/like/${destId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    action: actionToPerform
                })
            });

            if (!response.ok) {
                throw new Error('Failed to update favorite');
            }

            let destName = 'Destination';
            const cardTitle = button.closest('.recommendation-card')?.querySelector('h3 a');
            if (cardTitle) {
                destName = cardTitle.textContent;
            }

            if (actionToPerform === 'like') {
                button.classList.add('liked');
                icon.classList.remove('bi-heart');
                icon.classList.add('bi-heart-fill');
                this.showToast(`${destName} added to favorites!`, 'success');
            } else {
                button.classList.remove('liked');
                icon.classList.remove('bi-heart-fill');
                icon.classList.add('bi-heart');
                this.showToast(`${destName} removed from favorites`, 'info');
            }

            // Refresh recommendations after a delay
            setTimeout(() => {
                this.loadRecommendations();
            }, 1000);

        } catch (error) {
            console.error('Error updating favorite:', error);
            this.showToast('Failed to update favorites', 'error');
        }
    }

    setupFavoritesListener() {
        document.addEventListener('favoriteUpdated', () => {
            if (this.refreshTimeout) {
                clearTimeout(this.refreshTimeout);
            }
            this.refreshTimeout = setTimeout(() => {
                this.loadRecommendations();
            }, 1500);
        });
    }

    showToast(message, type = 'info') {
        if (window.toast) {
            window.toast.show(message, type);
        } else if (window.toastManager) {
            window.toastManager.show(message, type);
        } else {
            console.log(`[TOAST ${type}] ${message}`);
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Global refresh function
function refreshRecommendations() {
    console.log('[REC] Global refresh triggered');
    if (window.recommendationsManager) {
        window.recommendationsManager.loadRecommendations();
    } else {
        console.warn('[REC] RecommendationsManager not initialized yet');
    }
}

function initializeRecommendations(retryCount = 0) {
    const maxRetries = 5;
    const grid = document.getElementById('recommendations-grid');

    if (grid) {
        console.log('[REC] DOM ready - initializing RecommendationsManager');
        window.recommendationsManager = new RecommendationsManager();
    } else {
        if (retryCount < maxRetries) {
            console.warn(`[REC] Grid not found, retrying in ${100 * (retryCount + 1)}ms... (attempt ${retryCount + 1}/${maxRetries})`);
            setTimeout(() => initializeRecommendations(retryCount + 1), 100 * (retryCount + 1));
        } else {
            console.warn('[REC] Grid element not found after maximum retries - user may not be logged in or element does not exist');
        }
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    console.log('[REC] Waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[REC] DOMContentLoaded fired');
        initializeRecommendations();
    });
} else {
    console.log('[REC] DOM already loaded');
    initializeRecommendations();
}