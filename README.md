# 🧭 Voyager — Intelligent Travel Route Planner

> Plan smarter. Explore further. Share your journey.

Voyager is a full-stack travel planning web application that helps users discover destinations, build optimized multi-stop itineraries, and share their routes with a community of fellow travelers. Powered by Flask and integrated with Mapbox and OpenStreetMap, it combines route optimization algorithms with a social layer for collaborative trip planning.

---

## ✨ Features

### 🗺️ Trip Planner
- Build custom multi-stop itineraries with an interactive map interface
- **Nearest Neighbor route optimization** automatically reorders stops for the most efficient travel path
- Search and add destinations from a curated database directly into your plan
- Save trips as public or private; toggle visibility at any time
- Fork any community or featured trip to make it your own

### 📍 Destinations
- Browse a curated database of landmarks organized by category (Historical, Nature, Museums, and more)
- Filter by country, category, or keyword search
- View detailed destination pages with ratings, reviews, opening hours, and visit duration
- Add destinations to favorites with one click
- Personalized AI-powered recommendations on the destinations page

### 🌐 Community Hub
- Explore public trips shared by other users and official Voyager curators
- Like and bookmark trips for later reference
- Fork any trip into your own planner as a starting point
- Leave star ratings and written reviews on trips and destinations

### 👤 User Profiles
- Customizable profile with bio, avatar upload (up to 5 MB)
- View your saved trips, liked trips, and favorited destinations in one place
- Secure email/password authentication with password strength enforcement
- Password reset via email link with secure token expiry

### 🛡️ Admin Panel
- **Dashboard** with key statistics (total trips, destinations, reviews) and a 30-day trip creation chart
- **Trip Management** — search, filter by status (public/private/featured), bulk actions (make public, make private, delete), and toggle featured status
- **Destination Management** — view, search, and delete destinations
- **Review Moderation** — search and remove inappropriate reviews
- **Activity Logs** — full audit trail of user activity and admin actions with IP tracking

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3, Flask |
| Database | SQLite via Flask-SQLAlchemy |
| Authentication | Flask-Login, Werkzeug password hashing |
| Geocoding | Mapbox API + Nominatim (OpenStreetMap) — parallel requests |
| Frontend | Jinja2 templates, Bootstrap Icons, custom CSS |
| Maps | Mapbox GL JS |
| Charts | Chart.js (admin dashboard) |
| File Storage | Local filesystem (static/uploads) |
| Logging | Python `logging` with RotatingFileHandler (app, error, security logs) |

---

## 🚀 Getting Started

### Prerequisites

- Python 3.9+
- pip

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-username/voyager.git
cd voyager

# 2. Create and activate a virtual environment
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# 3. Install dependencies
pip install flask flask-sqlalchemy flask-login werkzeug requests

# 4. Run the application
python app.py
```

The app will be available at `http://127.0.0.1:5000`.

On first run, `db.create_all()` and `init_db()` are called automatically to create the database schema and seed initial data.

### Environment Configuration

The following values are hardcoded for development and should be moved to environment variables before deploying to production:

| Variable | Location in `app.py` | Description |
|---|---|---|
| `SECRET_KEY` | `app.secret_key` | Flask session secret |
| `MAPBOX_ACCESS_TOKEN` | `MAPBOX_ACCESS_TOKEN` | Mapbox API token |
| `SQLALCHEMY_DATABASE_URI` | `app.config[...]` | Database connection string |

---

## 🔑 Key API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Home page |
| `GET` | `/destinations` | Browse destinations (with filters & pagination) |
| `GET` | `/destination/<id>` | Destination detail page |
| `GET/POST` | `/planner` | Trip planner |
| `GET` | `/community` | Community trip feed |
| `GET` | `/route/<trip_id>` | Trip detail page |
| `POST` | `/fork_trip/<trip_id>` | Fork a trip |
| `GET/POST` | `/profile` | User profile |
| `GET` | `/api/geocode` | Geocoding proxy (Nominatim + Mapbox) |
| `GET` | `/admin` | Admin dashboard |
| `GET` | `/admin_trips` | Admin trip management |
| `GET` | `/admin_destinations` | Admin destination management |
| `GET` | `/admin_reviews` | Admin review moderation |
| `GET` | `/admin_logs` | Admin activity logs |

---

## 🏗️ Data Models

- **User** — authentication, profile, avatar, admin flag, favorites, liked trips
- **Trip** — title, stops (JSON), visibility, featured flag, author, likes, reviews
- **Destination** — name, city, country, category, coordinates, description, images, reviews
- **Review** — rating, comment, linked to user + destination or trip
- **ActivityLog** — user action audit trail with IP address
- **AdminLog** — admin-specific action audit trail

---

## 📄 License

This project was developed as a university coursework submission (University of Leeds). All rights reserved unless otherwise stated.
