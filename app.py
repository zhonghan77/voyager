import os
import mimetypes
import json
import re
import math
from collections import Counter
from datetime import datetime, timedelta
from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    flash,
    jsonify,
)
from werkzeug.security import generate_password_hash, check_password_hash
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager,
    UserMixin,
    login_user,
    login_required,
    logout_user,
    current_user,
)
import uuid
import time
import secrets
from functools import wraps
from flask import abort
import logging
from logging.handlers import RotatingFileHandler
import requests

app = Flask(__name__)
mimetypes.add_type("image/avif", ".avif")

# =========================================
# MAPBOX CONFIGURATION
# =========================================

MAPBOX_ACCESS_TOKEN = (
    "pk.eyJ1IjoiZmRodDYiLCJhIjoiY21qcXlqZXljM3cycTNlcXhzYWM5amQ5eCJ9."
    "GRf0xyGKW9-9qy5kNb9haw"
)

# =========================================
# CUSTOM JINJA2 FILTER - Image URL Handler
# =========================================


@app.template_filter("image_url")
def image_url_filter(image_path):
    """
    Intelligently handle image URLs - auto-detect local/external images

    Usage:
        <img src="{{ destination.image | image_url }}">

    Parameters:
        image_path: Image path, can be one of the following formats:
            - 'img/xxx.jpg' (relative path in static folder)
            - 'uploads/xxx.jpg' (relative path in static folder)
            - 'static/img/xxx.jpg' (full relative path)
            - 'https://...' (external full URL)
            - None (no image)

    Returns:
        Correct image URL path
    """
    if not image_path:
        # Return default avatar when no image
        return url_for("static", filename="img/Default_Avatar.png")

    if image_path.startswith(("http://", "https://")):
        # Return external link directly
        return image_path

    # If path already starts with /static/, return it directly
    # This matches the database format: /static/img/xxx.jpg
    if image_path.startswith("/static/"):
        return image_path

    # Handle local paths
    filename = image_path

    # Remove any 'static/' prefix (handle multiple occurrences)
    while filename.startswith("static/"):
        filename = filename[7:]  # Remove 'static/' (7 characters)

    # If the path doesn't start with a subdirectory, assume it's in img/
    if not filename.startswith(("img/", "uploads/")):
        # Check if it's just a filename (e.g., "_louvre_Museum.jpg")
        if "/" not in filename:
            # Try img/ first as default location for destination images
            filename = "img/" + filename

    return url_for("static", filename=filename)


# =========================================
#  CONFIGURATION
# =========================================

app.secret_key = (
    "320d5f2364700b0ea28f279c23876625c56264a8a45f074611af549ca1a347c1"
)

# Use absolute path
basedir = os.path.abspath(os.path.dirname(__file__))
db_path = os.path.join(basedir, "instance", "voyager.db")
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{db_path}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

UPLOAD_FOLDER = os.path.join("static", "uploads")
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

# Ensure upload directory exists
upload_path = os.path.join(basedir, UPLOAD_FOLDER)
os.makedirs(upload_path, exist_ok=True)

# =========================================
# LOGGING CONFIGURATION
# =========================================
# Create logs directory
logs_dir = os.path.join(basedir, "logs")
os.makedirs(logs_dir, exist_ok=True)

# Configure logging (only in production mode)
if not app.debug:
    # Application log handler
    file_handler = RotatingFileHandler(
        os.path.join(logs_dir, "voyager.log"),
        maxBytes=10485760,  # 10MB
        backupCount=10,
    )
    file_handler.setFormatter(
        logging.Formatter(
            "[%(asctime)s] %(levelname)s in %(module)s: %(message)s"
        )
    )
    file_handler.setLevel(logging.INFO)
    app.logger.addHandler(file_handler)

    # Error log handler
    error_handler = RotatingFileHandler(
        os.path.join(logs_dir, "errors.log"), maxBytes=10485760, backupCount=10
    )
    error_handler.setFormatter(
        logging.Formatter(
            "[%(asctime)s] %(levelname)s in %(module)s [%(pathname)s:%(lineno)d]:\n%(message)s"  # noqa: E501
        )
    )
    error_handler.setLevel(logging.ERROR)
    app.logger.addHandler(error_handler)

    # Security log handler
    security_handler = RotatingFileHandler(
        os.path.join(logs_dir, "security.log"),
        maxBytes=10485760,
        backupCount=10,
    )
    security_handler.setFormatter(
        logging.Formatter("[%(asctime)s] SECURITY - %(message)s")
    )
    security_handler.setLevel(logging.WARNING)
    app.logger.addHandler(security_handler)

    app.logger.setLevel(logging.INFO)
    app.logger.info("Voyager application startup")

db = SQLAlchemy(app)
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "login"


def allowed_file(filename):
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS
    )


@app.context_processor
def inject_global_vars():
    return {"cache_buster": int(time.time())}


# =========================================
#  MAPBOX GEOCODING PROXY API
# =========================================


@app.route("/api/geocode", methods=["GET"])
def geocode_proxy():
    """
    OPTIMIZED: Parallel geocoding with Nominatim + Mapbox

    Performance improvements:
    - Concurrent API requests (parallel instead of sequential)
    - Reduced timeout for faster failure recovery
    - Early return if one source has good results

    Query Parameters:
        q (str): Search query (required)
        limit (str): Number of results to return (optional, default: 10)

    Returns:
        JSON array of location results

    Example:
        GET /api/geocode?q=London&limit=5
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import time

    # Get search query from request
    query = request.args.get("q", "")
    if not query:
        return jsonify({"error": "Missing query parameter"}), 400

    # Get result limit (default: 10)
    limit = int(request.args.get("limit", "10"))

    start_time = time.time()

    # =========================================
    # Helper functions for parallel execution
    # =========================================

    def search_nominatim():
        """Search Nominatim (OSM) - Better POI coverage"""
        results = []
        try:
            nominatim_url = "https://nominatim.openstreetmap.org/search"
            nominatim_params = {
                "q": query,
                "format": "json",
                "limit": 10,  # Reduced from 15 for faster response
                "addressdetails": 0,  # Disabled to reduce response size
                "accept-language": "en",  # Single language for speed
            }

            nominatim_headers = {
                "User-Agent": "VoyagerTripPlanner/1.0"
            }

            response = requests.get(
                nominatim_url,
                params=nominatim_params,
                headers=nominatim_headers,
                timeout=2  # Reduced timeout for faster response
            )

            if response.ok:
                data = response.json()

                for item in data:
                    osm_class = item.get("class", "")

                    # Quick POI detection
                    is_poi = osm_class in ["tourism",
                                           "amenity", "historic", "leisure"]

                    results.append({
                        "lat": float(item["lat"]),
                        "lon": float(item["lon"]),
                        "display_name": item["display_name"],
                        "name": item.get("name", item["display_name"].split(",")[0]),  # noqa: E501
                        "type": "poi" if is_poi else "place",
                        "address": {},
                        "source": "nominatim",
                        "relevance": 1.0 if is_poi else 0.5,
                    })

                app.logger.info(
                    f"Nominatim: {len(data)} results in {time.time()-start_time:.2f}s")  # noqa: E501

        except Exception as e:
            app.logger.warning(f"Nominatim failed: {str(e)}")

        return results

    def search_mapbox():
        """Search Mapbox - Fast and reliable"""
        results = []
        try:
            url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{requests.utils.quote(query)}.json"  # noqa: E501

            params = {
                "access_token": MAPBOX_ACCESS_TOKEN,
                "limit": "8",  # Reduced for faster response
                "language": "en",
                "types": "poi,place",  # Removed address/locality for speed
            }

            response = requests.get(url, params=params, timeout=2)

            if response.ok:
                data = response.json()

                for feature in data.get("features", []):
                    place_types = feature.get("place_type", ["place"])
                    results.append({
                        "lat": feature["center"][1],
                        "lon": feature["center"][0],
                        "display_name": feature["place_name"],
                        "name": feature.get("text", ""),
                        "type": place_types[0],
                        "address": {},
                        "source": "mapbox",
                        "relevance": feature.get("relevance", 0),
                    })

                app.logger.info(
                    f"Mapbox: {len(data.get('features', []))} results in {time.time()-start_time:.2f}s")  # noqa: E501

        except Exception as e:
            app.logger.warning(f"Mapbox failed: {str(e)}")

        return results

    # =========================================
    # Execute searches in parallel
    # =========================================

    all_results = []

    with ThreadPoolExecutor(max_workers=2) as executor:
        # Submit both searches concurrently
        future_nominatim = executor.submit(search_nominatim)
        future_mapbox = executor.submit(search_mapbox)

        # Collect results as they complete
        for future in as_completed([future_nominatim, future_mapbox], timeout=3):  # noqa: E501
            try:
                results = future.result()
                all_results.extend(results)
            except Exception as e:
                app.logger.warning(f"Search future failed: {str(e)}")

    # If no results, return error
    if not all_results:
        app.logger.error(f"All geocoding services failed for query: {query}")
        return jsonify({"error": "Geocoding service unavailable"}), 503

    # =========================================
    # Quick deduplication (simplified)
    # =========================================

    seen = set()
    deduplicated = []

    for result in all_results:
        # Create a simple key based on rounded coordinates
        key = (round(result["lat"], 3), round(result["lon"], 3))

        if key not in seen:
            seen.add(key)
            deduplicated.append(result)
        elif result["type"] == "poi":
            # Replace non-POI with POI if duplicate
            for i, existing in enumerate(deduplicated):
                existing_key = (
                    round(existing["lat"], 3), round(existing["lon"], 3))
                if existing_key == key and existing["type"] != "poi":
                    deduplicated[i] = result
                    break

    # =========================================
    # Sort: POI first, then by relevance
    # =========================================

    def sort_key(result):
        type_priority = {"poi": 0, "place": 1, "locality": 2, "address": 3}
        priority = type_priority.get(result["type"], 4)
        return (priority, -result["relevance"])

    deduplicated.sort(key=sort_key)

    # Limit results
    final_results = deduplicated[:limit]

    elapsed = time.time() - start_time
    app.logger.info(
        f"Geocode completed in {elapsed:.2f}s: {len(final_results)} results")

    return jsonify(final_results)


# =========================================
# OPENROUTESERVICE CONFIGURATION
# =========================================

OPENROUTESERVICE_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijc0MmY0MTE5YTA2YjRkMjhhNjk3ZjlmNDhlMGEzM2YwIiwiaCI6Im11cm11cjY0In0="  # noqa: E501

# =========================================
# OPENROUTESERVICE ROUTING PROXY API
# =========================================


@app.route("/api/route", methods=["GET"])
def route_proxy():
    """
    Proxy for OpenRouteService Directions API

    This endpoint proxies routing requests to OpenRouteService,
    avoiding CORS issues, API key exposure, and connection problems from China mainland.  # noqa: E501

    Query Parameters:
        from_lat (float): Starting latitude (required)
        from_lon (float): Starting longitude (required)
        to_lat (float): Ending latitude (required)
        to_lon (float): Ending longitude (required)
        profile (str): Transport mode (optional, default: 'driving-car')
                      Options:
                      - 'driving-car': Car routing
                      - 'cycling-regular': Bicycle routing
                      - 'foot-walking': Pedestrian routing

    Returns:
        JSON: OpenRouteService route data including:
        - coordinates: Array of [lat, lon] points
        - distance: Total distance in kilometers
        - duration: Total duration in minutes
        - elevation data (ascent/descent)
        - turn-by-turn steps

    Status Codes:
        200: Success
        400: Missing required parameters
        503: OpenRouteService API unavailable
        500: Internal server error

    """
    # Get and validate parameters
    from_lat = request.args.get("from_lat")
    from_lon = request.args.get("from_lon")
    to_lat = request.args.get("to_lat")
    to_lon = request.args.get("to_lon")
    profile = request.args.get("profile", "driving-car")

    # Validate required parameters
    if not all([from_lat, from_lon, to_lat, to_lon]):
        return (
            jsonify(
                {
                    "error": "Missing required parameters",
                    "required": ["from_lat", "from_lon", "to_lat", "to_lon"],
                }
            ),
            400,
        )

    # Validate profile
    valid_profiles = ["driving-car", "cycling-regular", "foot-walking"]
    if profile not in valid_profiles:
        return (
            jsonify(
                {"error": "Invalid profile", "valid_profiles": valid_profiles}
            ),
            400,
        )

    try:
        # Build OpenRouteService API URL
        # Documentation:
        # https://openrouteservice.org/dev/#/api-docs/v2/directions/{profile}/get
        url = f"https://api.openrouteservice.org/v2/directions/{profile}"

        # API parameters
        # Note: OpenRouteService uses lon,lat order (not lat,lon!)
        params = {
            "api_key": OPENROUTESERVICE_API_KEY,
            "start": f"{from_lon},{from_lat}",  # lon,lat order
            "end": f"{to_lon},{to_lat}",  # lon,lat order
        }

        # Send request to OpenRouteService
        response = requests.get(url, params=params, timeout=15)
        response.raise_for_status()

        # Return the route data directly
        # OpenRouteService returns GeoJSON format which the frontend expects
        return jsonify(response.json())

    except requests.HTTPError as e:
        # Handle HTTP errors (400, 401, 403, 404, etc.)
        status_code = e.response.status_code if e.response else 503
        app.logger.error(
            f"OpenRouteService HTTP error {status_code}: {str(e)}"
        )
        error_msg = "Routing service unavailable"
        if status_code == 401:
            error_msg = "Invalid API key"
        elif status_code == 403:
            error_msg = "API key rate limit exceeded"
        elif status_code == 404:
            error_msg = "Route not found"

        return jsonify({"error": error_msg}), 503

    except requests.Timeout:
        app.logger.error("OpenRouteService request timeout")
        return jsonify({"error": "Routing service timeout"}), 503

    except requests.RequestException as e:
        # Handle other request errors (connection, etc.)
        app.logger.error(f"OpenRouteService request error: {str(e)}")
        return jsonify({"error": "Routing service unavailable"}), 503

    except Exception as e:
        # Handle unexpected errors
        app.logger.error(f"Unexpected error in route_proxy: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


# =========================================
# 2. DATABASE MODELS
# =========================================


user_favorites = db.Table(
    "user_favorites",
    db.Column(
        "user_id", db.Integer, db.ForeignKey("user.id"), primary_key=True
    ),
    db.Column(
        "destination_id",
        db.Integer,
        db.ForeignKey("destination.id"),
        primary_key=True,
    ),
)


class Review(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    destination_id = db.Column(
        db.Integer, db.ForeignKey("destination.id"), nullable=False
    )
    rating = db.Column(db.Integer, nullable=False)
    comment = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    user = db.relationship("User", backref="reviews", lazy=True)


class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), nullable=False, unique=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    bio = db.Column(db.Text, default="Ready to explore the world.")
    avatar = db.Column(
        db.String(200), default="/static/img/Default_Avatar.png"
    )

    # Admin fields
    is_admin = db.Column(db.Boolean, default=False)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime)

    # Password reset fields
    reset_token = db.Column(db.String(100), nullable=True)
    reset_token_expiry = db.Column(db.DateTime, nullable=True)

    favorites = db.relationship(
        "Destination",
        secondary=user_favorites,
        lazy="subquery",
        backref=db.backref("favorited_by", lazy=True),
    )
    trips = db.relationship("Trip", backref="author", lazy=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def generate_reset_token(self):
        """Generate a secure password reset token"""
        self.reset_token = secrets.token_urlsafe(32)
        self.reset_token_expiry = datetime.utcnow() + timedelta(hours=1)
        return self.reset_token

    def verify_reset_token(self, token):
        """Verify if the reset token is valid and not expired"""
        if not self.reset_token or not self.reset_token_expiry:
            return False
        if self.reset_token != token:
            return False
        if datetime.utcnow() > self.reset_token_expiry:
            return False
        return True

    def clear_reset_token(self):
        """Clear the reset token after use"""
        self.reset_token = None
        self.reset_token_expiry = None


# Admin Log Model
class AdminLog(db.Model):
    """Administrator operation log"""

    __tablename__ = "admin_log"
    id = db.Column(db.Integer, primary_key=True)
    admin_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    action_type = db.Column(db.String(50), nullable=False)
    target_type = db.Column(db.String(50))
    target_id = db.Column(db.Integer)
    details = db.Column(db.Text)
    ip_address = db.Column(db.String(50))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    admin = db.relationship(
        "User", backref="admin_actions", foreign_keys=[admin_id]
    )


# Trip favorites many-to-many relationship table
trip_favorites = db.Table(
    "trip_favorites",
    db.Column(
        "user_id", db.Integer, db.ForeignKey("user.id"), primary_key=True
    ),
    db.Column(
        "trip_id", db.Integer, db.ForeignKey("trip.id"), primary_key=True
    ),
)


class Trip(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    title = db.Column(db.String(100), nullable=False)
    name = db.Column(db.String(200))
    region = db.Column(db.String(100), default="world")
    data = db.Column(db.Text)
    total_stops = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    is_public = db.Column(db.Boolean, default=False)
    is_featured = db.Column(db.Boolean, default=False)
    featured_key = db.Column(db.String(50), unique=True, nullable=True)
    stops = db.relationship(
        "TripStop", backref="trip", lazy=True, cascade="all, delete-orphan"
    )

    # Relationships for likes and favorites
    likes = db.relationship(
        "TripLike",
        backref="trip",
        lazy="dynamic",
        cascade="all, delete-orphan",
    )
    favorited_by_users = db.relationship(
        "User",
        secondary=trip_favorites,
        lazy="subquery",
        backref=db.backref("favorite_trips", lazy=True),
    )

    def get_avg_rating(self):
        """Get average rating for this trip"""
        if not hasattr(self, "reviews") or not self.reviews:
            return 0
        total = sum([r.rating for r in self.reviews])
        return round(total / len(self.reviews), 1)

    def get_likes_count(self):
        """Get number of likes for this trip"""
        return self.likes.count()

    def is_liked_by(self, user):
        """Check if trip is liked by given user"""
        if not user or not user.is_authenticated:
            return False
        return self.likes.filter_by(user_id=user.id).first() is not None

    def is_favorited_by(self, user):
        """Check if trip is favorited by given user"""
        if not user or not user.is_authenticated:
            return False
        return user in self.favorited_by_users


# Trip likes table
class TripLike(db.Model):
    __tablename__ = "trip_like"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    trip_id = db.Column(db.Integer, db.ForeignKey("trip.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint("user_id", "trip_id", name="unique_trip_like"),
    )


# Trip reviews table


class TripReview(db.Model):
    __tablename__ = "trip_review"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    trip_id = db.Column(db.Integer, db.ForeignKey("trip.id"), nullable=False)
    rating = db.Column(db.Integer, nullable=False)
    comment = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    user = db.relationship("User", backref="trip_reviews", lazy=True)
    trip = db.relationship("Trip", backref="reviews", lazy=True)

    __table_args__ = (
        db.UniqueConstraint("user_id", "trip_id", name="unique_trip_review"),
    )


class TripStop(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    trip_id = db.Column(db.Integer, db.ForeignKey("trip.id"), nullable=False)
    destination_name = db.Column(db.String(100))
    lat = db.Column(db.Float)
    lon = db.Column(db.Float)
    order = db.Column(db.Integer)


class Destination(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    city = db.Column(db.String(100), nullable=False)
    category = db.Column(db.String(50))
    image = db.Column(db.String(200))
    desc = db.Column(db.Text)
    lat = db.Column(db.Float)
    lon = db.Column(db.Float)

    opening_hours = db.Column(db.Text)
    admission_adult = db.Column(db.Text)
    admission_child = db.Column(db.Text)
    admission_notes = db.Column(db.Text)
    phone = db.Column(db.String(100))
    website = db.Column(db.String(200))
    email = db.Column(db.String(100))
    transport_train = db.Column(db.Text)
    transport_bus = db.Column(db.Text)
    transport_car = db.Column(db.Text)
    visit_duration = db.Column(db.String(100))
    best_time_to_visit = db.Column(db.Text)
    detailed_description = db.Column(db.Text)
    history = db.Column(db.Text)
    tips = db.Column(db.Text)
    facilities = db.Column(db.Text)

    reviews = db.relationship(
        "Review",
        backref="destination",
        lazy=True,
        cascade="all, delete-orphan",
    )

    def get_avg_rating(self):
        if not self.reviews:
            return 0
        total = sum([r.rating for r in self.reviews])
        return round(total / len(self.reviews), 1)

    def get_tips(self):
        if self.tips:
            try:
                return json.loads(self.tips)
            except Exception:
                return []
        return []

    def get_facilities(self):
        if self.facilities:
            try:
                return json.loads(self.facilities)
            except Exception:
                return []
        return []


# =========================================
# ACTIVITY LOG MODEL
# =========================================


class ActivityLog(db.Model):
    """
    Tracks all significant user and system activities
    Provides audit trail and security monitoring
    """

    __tablename__ = "activity_log"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    username = db.Column(db.String(100))
    action_type = db.Column(db.String(50), nullable=False)
    action_category = db.Column(db.String(50))
    description = db.Column(db.Text)
    details = db.Column(db.Text)
    ip_address = db.Column(db.String(50))
    user_agent = db.Column(db.String(300))
    status = db.Column(db.String(20))
    created_at = db.Column(
        db.DateTime, default=datetime.utcnow, nullable=False
    )

    user = db.relationship(
        "User", backref="activity_logs", foreign_keys=[user_id]
    )

    def __repr__(self):
        return f"<ActivityLog {self.action_type} by {self.username} at {self.created_at}>"  # noqa: E501

    def get_details_dict(self):
        """Parse JSON details safely"""
        if self.details:
            try:
                return json.loads(self.details)
            except Exception:
                return {}
        return {}


# =========================================
# LOGGING HELPER FUNCTIONS
# =========================================
def log_activity(
    action_type,
    action_category,
    description,
    user=None,
    details=None,
    status="success",
):
    """
    Universal activity logging function

    Args:
        action_type: Type of action (e.g., 'login', 'create_trip')
        action_category: Category (e.g., 'auth', 'trip', 'profile')
        description: Human-readable description
        user: User object (optional, uses current_user if available)
        details: Dictionary of additional details (will be JSON serialized)
        status: 'success', 'failed', or 'error'
    """
    try:
        if (
            user is None
            and hasattr(current_user, "id")
            and current_user.is_authenticated
        ):
            user = current_user

        ip_address = request.remote_addr if request else "system"
        user_agent = (
            request.user_agent.string
            if request and hasattr(request, "user_agent")
            else "system"
        )

        log_entry = ActivityLog(
            user_id=user.id if user else None,
            username=user.username if user else "system",
            action_type=action_type,
            action_category=action_category,
            description=description,
            details=json.dumps(details) if details else None,
            ip_address=ip_address[:50] if ip_address else None,
            user_agent=user_agent[:300] if user_agent else None,
            status=status,
        )

        db.session.add(log_entry)
        db.session.commit()

        log_message = (
            f"[{action_category.upper()}] {action_type}: {description}"
        )
        if user:
            log_message += f" | User: {user.username} (ID: {user.id})"
        if ip_address and ip_address != "system":
            log_message += f" | IP: {ip_address}"

        if status == "success":
            app.logger.info(log_message)
        elif status == "failed":
            app.logger.warning(log_message)
        else:
            app.logger.error(log_message)

    except Exception as e:
        app.logger.error(f"Failed to log activity: {str(e)}")
        try:
            db.session.rollback()
        except Exception:
            pass


def log_security_event(event_type, description, user=None, severity="warning"):
    """
    Log security-related events

    Args:
        event_type: Type of security event
        description: Description of the event
        user: User object involved
        severity: 'info', 'warning', or 'critical'
    """
    log_activity(
        action_type=event_type,
        action_category="security",
        description=description,
        user=user,
        status="failed" if severity == "critical" else "success",
    )

    log_message = f"[{severity.upper()}] {event_type}: {description}"
    if user:
        log_message += f" | User: {user.username}"
    if request:
        log_message += f" | IP: {request.remote_addr}"

    if severity == "critical":
        app.logger.error(log_message)
    else:
        app.logger.warning(log_message)


# =========================================
# REQUEST HOOKS - Automatic Logging
# =========================================


@app.before_request
def before_request_logging():
    """Log incoming requests"""
    if request.endpoint and not request.endpoint.startswith("static"):
        request.start_time = time.time()


@app.after_request
def after_request_logging(response):
    """Log completed requests with response status"""
    if (
        hasattr(request, "start_time")
        and request.endpoint
        and not request.endpoint.startswith("static")
    ):
        duration = time.time() - request.start_time

        if duration > 1.0:
            app.logger.warning(
                f"Slow request: {request.method} {request.path} | "
                f"Duration: {duration:.2f}s | Status: {response.status_code}"
            )

        if response.status_code >= 400:
            app.logger.warning(
                f"Error response: {request.method} {request.path} | "
                f"Status: {response.status_code} | User: {current_user.username if current_user.is_authenticated else 'Anonymous'}"  # noqa: E501
            )

    return response


@app.errorhandler(404)
def not_found_error(error):
    """Handle 404 errors"""
    # IMPORTANT: Don't log static file 404s to prevent infinite loop
    if request.path.startswith("/static/"):
        # Silently return 404 for missing static files
        return "File not found", 404

    # Only log non-static file 404s
    try:
        log_activity(
            action_type="404_error",
            action_category="system",
            description=f"Page not found: {request.path}",
            status="error",
        )
    except Exception as e:
        # If logging fails, don't crash the error handler
        app.logger.error(f"Failed to log 404: {e}")

    # Return 404 page instead of redirecting (redirect causes loop)
    try:
        return render_template("404.html"), 404
    except Exception:
        # If 404 template doesn't exist, return simple HTML
        return (
            """
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">  # noqa: E501
            <title>404 - Page Not Found</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    text-align: center;
                    padding: 50px;
                    background-color: #f5f5f5;
                }
                .error-container {
                    max-width: 600px;
                    margin: 0 auto;
                    background: white;
                    padding: 40px;
                    border-radius: 8px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                h1 { color: #e74c3c; font-size: 72px; margin: 0; }
                h2 { color: #333; margin: 20px 0; }
                p { color: #666; margin: 20px 0; }
                a {
                    display: inline-block;
                    padding: 10px 30px;
                    background-color: #3498db;
                    color: white;
                    text-decoration: none;
                    border-radius: 5px;
                    margin-top: 20px;
                }
                a:hover { background-color: #2980b9; }
            </style>
        </head>
        <body>
            <div class="error-container">
                <h1>404</h1>
                <h2>Page Not Found</h2>
                <p>The page you are looking for does not exist.</p>
                <a href="/">Return to Home</a>
            </div>
        </body>
        </html>
        """,
            404,
        )


@app.errorhandler(500)
def internal_error(error):
    """Handle 500 errors"""
    db.session.rollback()
    app.logger.error(f"Internal server error: {str(error)}")
    log_activity(
        action_type="500_error",
        action_category="system",
        description=f"Internal error on {request.path}: {str(error)}",
        status="error",
    )
    flash("An internal error occurred", "error")
    return redirect(url_for("home"))


@app.errorhandler(403)
def forbidden_error(error):
    """Handle 403 errors"""
    log_security_event(
        event_type="unauthorized_access",
        description=f"Attempted to access forbidden resource: {request.path}",
        severity="warning",
    )
    flash("Access forbidden", "error")
    return redirect(url_for("home"))


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


# =========================================
# INPUT VALIDATION FUNCTIONS
# =========================================


def validate_email(email):
    """Validate email format"""
    if not email or len(email) < 5:
        return False, "Email is required and must be at least 5 characters"

    email_pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"

    if not re.match(email_pattern, email):
        return False, "Invalid email format (e.g., user@example.com)"

    if len(email) > 120:
        return False, "Email is too long (max 120 characters)"

    return True, ""


def validate_username(username):
    """Validate username format"""
    if not username or len(username) < 3:
        return False, "Username must be at least 3 characters long"

    if len(username) > 50:
        return False, "Username is too long (max 50 characters)"

    if not re.match(r"^[a-zA-Z0-9_-]+$", username):
        return (
            False,
            "Username can only contain letters, numbers, underscores, and hyphens",  # noqa: E501
        )

    if username.isdigit():
        return False, "Username cannot be all numbers"

    return True, ""


def validate_password(password):
    """
    Enhanced password validation with strict strength requirements
    This matches the frontend validation in register.html
    """
    if not password:
        return False, "Password is required"

    # Length validation
    if len(password) < 8:
        return False, "Password must be at least 8 characters long"

    if len(password) > 128:
        return False, "Password is too long (max 128 characters)"

    # Must contain at least one uppercase letter
    if not re.search(r"[A-Z]", password):
        return (
            False,
            "Password must contain at least one uppercase letter (A-Z)",
        )

    # Must contain at least one lowercase letter
    if not re.search(r"[a-z]", password):
        return (
            False,
            "Password must contain at least one lowercase letter (a-z)",
        )

    # Must contain at least one number
    if not re.search(r"\d", password):
        return False, "Password must contain at least one number (0-9)"

    # Check for common weak passwords
    common_passwords = [
        "password",
        "12345678",
        "qwerty123",
        "Password1",
        "Password123",
        "Welcome1",
        "Admin123",
    ]
    if password.lower() in [p.lower() for p in common_passwords]:
        return (
            False,
            "This password is too common. Please choose a stronger password",
        )

    # Check for long sequential characters (4+ characters)
    if re.search(
        r"(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef)",
        password.lower(),
    ):
        return (
            False,
            "Password contains sequential characters. Please choose a stronger password",  # noqa: E501
        )

    return True, ""


def sanitize_input(text, max_length=100):
    """Clean user input"""
    if not text:
        return ""
    text = text.strip()
    if len(text) > max_length:
        text = text[:max_length]
    return text


# =========================================
#  RECOMMENDATION ENGINE
# =========================================


class RecommendationEngine:
    """
    Enhanced recommendation engine
    Implements content-based filtering and collaborative filtering algorithms
    """

    def __init__(self):
        """Initialize recommendation engine"""
        pass

    def get_recommendations(self, user, limit=3):
        """
        Main recommendation method

        Args:
            user: Current user object
            limit: Number of recommendations to return

        Returns:
            dict: Recommendation results
        """
        user_favorites = user.favorites
        fav_ids = [d.id for d in user_favorites]

        # Choose strategy based on user data
        if not user_favorites:
            # Cold start: no favorites
            return self._get_popular_recommendations(fav_ids, limit)
        elif len(user_favorites) < 3:
            # Limited data: hybrid recommendations
            return self._get_hybrid_recommendations(user, fav_ids, limit)
        else:
            # Rich data: fully personalized recommendations
            return self._get_personalized_recommendations(user, fav_ids, limit)

    def _get_personalized_recommendations(self, user, fav_ids, limit):
        """Generate personalized recommendations"""
        # Get candidate destinations
        candidates = Destination.query.filter(
            Destination.id.notin_(fav_ids)
        ).all()

        if not candidates:
            return self._get_popular_recommendations(fav_ids, limit)

        # Score each candidate
        scored_candidates = []
        for dest in candidates:
            score_data = self._calculate_recommendation_score(user, dest)
            scored_candidates.append(
                {
                    "destination": dest,
                    "score": score_data["total_score"],
                    "reasons": score_data["reasons"],
                    "score_breakdown": score_data["breakdown"],
                }
            )

        # Sort and select diverse recommendations
        scored_candidates.sort(key=lambda x: x["score"], reverse=True)
        selected = self._select_diverse_recommendations(
            scored_candidates, limit
        )

        # Format response
        destinations = []
        for item in selected:
            dest = item["destination"]
            destinations.append(
                {
                    "id": dest.id,
                    "name": dest.name,
                    "city": dest.city,
                    "category": dest.category,
                    "image": dest.image,
                    "rating": dest.get_avg_rating(),
                    "reviews_count": len(dest.reviews),
                    "desc": dest.desc,
                    "reasons": item["reasons"],
                    "recommendation_score": min(99, int(item["score"])),
                }
            )

        return {
            "type": "personalized",
            "message": "Tailored to your travel style and preferences",
            "destinations": destinations,
        }

    def _calculate_recommendation_score(self, user, destination):
        """
        Calculate comprehensive recommendation score

        Score composition:
        1. Category preference (0-30åˆ†)
        2. åŸŽå¸‚/Location preference (0-20åˆ†)
        3. Rating preference (0-20åˆ†)
        4. Collaborative filtering (0-20åˆ†)
        5. Recency bonus (0-10åˆ†)
        """
        reasons = []
        breakdown = {}
        total_score = 0

        # 1. Category preference
        category_score = self._score_category_preference(user, destination)
        breakdown["category"] = category_score
        total_score += category_score
        if category_score > 15:
            reasons.append(f"Matches your interest in {destination.category}")

        # 2. Location preference
        location_score = self._score_location_preference(user, destination)
        breakdown["location"] = location_score
        total_score += location_score
        if location_score > 10:
            city_count = sum(
                1 for fav in user.favorites if fav.city == destination.city
            )
            if city_count > 0:
                reasons.append(
                    f"You've saved {city_count} other place(s) in {destination.city}"  # noqa: E501
                )

        # 3. Rating preference
        rating_score = self._score_rating_preference(user, destination)
        breakdown["rating"] = rating_score
        total_score += rating_score
        if destination.get_avg_rating() >= 4.5:
            reasons.append(
                f"Highly rated ({destination.get_avg_rating()}â˜…) destination"
            )

        # 4. Collaborative filtering
        collab_score = self._score_collaborative_filtering(user, destination)
        breakdown["collaborative"] = collab_score
        total_score += collab_score
        if collab_score > 10:
            reasons.append("Popular with travelers like you")

        # 5. Recency bonus
        recency_score = self._score_recency(destination)
        breakdown["recency"] = recency_score
        total_score += recency_score

        # Ensure at least 2 reasons
        if len(reasons) < 2:
            if destination.get_avg_rating() > 4.0:
                reasons.append(
                    f"Excellent {destination.get_avg_rating()}â˜… rating"
                )
            if len(destination.reviews) > 5:
                reasons.append(f"{len(destination.reviews)} verified reviews")

        return {
            "total_score": total_score,
            "reasons": reasons[:3],  # Maximum 3 reasons
            "breakdown": breakdown,
        }

    def _score_category_preference(self, user, destination):
        """Score based on category preference (0-30 points)"""
        if not user.favorites:
            return 0

        category_counts = Counter([fav.category for fav in user.favorites])
        total_favorites = len(user.favorites)

        if destination.category in category_counts:
            category_ratio = (
                category_counts[destination.category] / total_favorites
            )
            score = category_ratio * 30
            return score

        return 5  # Base score for unexplored categories

    def _score_location_preference(self, user, destination):
        """Score based on location preference (0-20 points)"""
        if not user.favorites:
            return 0

        city_counts = Counter([fav.city for fav in user.favorites])
        total_favorites = len(user.favorites)

        if destination.city in city_counts:
            city_ratio = city_counts[destination.city] / total_favorites
            score = city_ratio * 20
            return score

        # Reward for exploring different cities
        user_cities = set([fav.city for fav in user.favorites])
        if len(user_cities) > 0:
            return 3

        return 0

    def _score_rating_preference(self, user, destination):
        """Score based on rating preference (0-20 points)"""
        dest_rating = destination.get_avg_rating()

        if not dest_rating:
            return 5

        # Analyze user's rating habits
        user_reviews = Review.query.filter_by(user_id=user.id).all()

        if user_reviews:
            avg_user_rating = sum(r.rating for r in user_reviews) / len(
                user_reviews
            )
            rating_diff = abs(avg_user_rating - dest_rating)
            score = max(0, 20 - (rating_diff * 4))
        else:
            # No review history - prefer highly rated destinations
            score = (dest_rating / 5.0) * 20

        return score

    def _score_collaborative_filtering(self, user, destination):
        """Score based on collaborative filtering (0-20 points)"""
        similar_users = self._find_similar_users(user, limit=10)

        if not similar_users:
            return 0

        # Count how many similar users like this destination
        likes_count = 0
        for similar_user, similarity_score in similar_users:
            if destination in similar_user.favorites:
                likes_count += similarity_score

        # Normalize score
        max_possible_score = sum(score for _, score in similar_users)
        if max_possible_score > 0:
            score = (likes_count / max_possible_score) * 20
            return score

        return 0

    def _find_similar_users(self, user, limit=10):
        """
        Find similar users using Jaccard similarity

        Returns:
            List of (user, similarity_score) tuples
        """
        if not user.favorites:
            return []

        user_fav_ids = set([d.id for d in user.favorites])

        # Get all users with favorites
        all_users = User.query.filter(User.id != user.id).all()

        similar_users = []
        for other_user in all_users:
            if not other_user.favorites:
                continue

            other_fav_ids = set([d.id for d in other_user.favorites])

            # Calculate Jaccard similarity
            intersection = len(user_fav_ids & other_fav_ids)
            union = len(user_fav_ids | other_fav_ids)

            if union > 0:
                similarity = intersection / union
                if similarity > 0.1:  # At least 10% similarity
                    similar_users.append((other_user, similarity))

        # Sort by similarity and return top N
        similar_users.sort(key=lambda x: x[1], reverse=True)
        return similar_users[:limit]

    def _score_recency(self, destination):
        """Give bonus to destinations with recent reviews (0-10 points)"""
        if not destination.reviews:
            return 0

        # Get most recent reviews
        recent_reviews = sorted(
            destination.reviews, key=lambda r: r.created_at, reverse=True
        )
        most_recent = recent_reviews[0].created_at

        # Calculate days from now
        days_ago = (datetime.utcnow() - most_recent).days

        # Bonus for reviews within 30 days
        if days_ago <= 30:
            score = 10 - (days_ago / 30 * 10)
            return max(0, score)

        return 0

    def _select_diverse_recommendations(self, scored_candidates, limit):
        """Select diverse recommendations"""
        selected = []
        _ = set()
        _ = set()

        for candidate in scored_candidates:
            if len(selected) >= limit:
                break

            dest = candidate["destination"]

            # Diversity check
            category_count = sum(
                1
                for s in selected
                if s["destination"].category == dest.category
            )
            city_count = sum(
                1 for s in selected if s["destination"].city == dest.city
            )

            # Allow maximum 2 same categories, 1 same city
            if category_count < 2 and city_count < 1:
                selected.append(candidate)
            elif len(selected) < limit and category_count < 2:
                selected.append(candidate)

        # If still not enough, take highest scores
        while len(selected) < limit and len(selected) < len(scored_candidates):
            for candidate in scored_candidates:
                if candidate not in selected:
                    selected.append(candidate)
                    break

        return selected[:limit]

    def _get_hybrid_recommendations(self, user, fav_ids, limit):
        """Hybrid recommendation strategy (when user data is limited)"""
        personalized_limit = limit // 2
        popular_limit = limit - personalized_limit

        personalized = self._get_personalized_recommendations(
            user, fav_ids, personalized_limit
        )
        popular = self._get_popular_recommendations(fav_ids, popular_limit)

        combined_destinations = (
            personalized["destinations"][:personalized_limit]
            + popular["destinations"][:popular_limit]
        )

        return {
            "type": "personalized",
            "message": "Getting to know your preferences...",
            "destinations": combined_destinations[:limit],
        }

    def _get_popular_recommendations(self, fav_ids, limit):
        """Popularity-based recommendations (cold start or fallback)"""
        if fav_ids:
            candidates = Destination.query.filter(
                Destination.id.notin_(fav_ids)
            ).all()
        else:
            candidates = Destination.query.all()

        if not candidates:
            return {
                "type": "popular",
                "message": "You've explored everything!",
                "destinations": [],
            }

        # Popularity score (rating * log(review_count + 1))
        scored = []
        for dest in candidates:
            rating = dest.get_avg_rating()
            review_count = len(dest.reviews)
            popularity_score = rating * math.log(review_count + 1) * 10
            scored.append((dest, popularity_score))

        scored.sort(key=lambda x: x[1], reverse=True)

        # Format response
        destinations = []
        for dest, score in scored[:limit]:
            reasons = []

            if dest.get_avg_rating() >= 4.5:
                reasons.append(f"Highly rated ({dest.get_avg_rating()}â˜…)")
            if len(dest.reviews) >= 10:
                reasons.append(f"Popular with {len(dest.reviews)} reviews")
            if not reasons:
                reasons.append(f"Top destination in {dest.category}")
                reasons.append("Great for first-time visitors")

            destinations.append(
                {
                    "id": dest.id,
                    "name": dest.name,
                    "city": dest.city,
                    "category": dest.category,
                    "image": dest.image,
                    "rating": dest.get_avg_rating(),
                    "reviews_count": len(dest.reviews),
                    "desc": dest.desc,
                    "reasons": reasons[:3],
                    "recommendation_score": min(90, int(score)),
                }
            )

        return {
            "type": "popular",
            "message": "Popular destinations to get you started",
            "destinations": destinations,
        }


# =========================================
# DATA SEEDING
# =========================================

# =========================================
# DATA MAPPING - Image and Coordinate Data
# =========================================


# =========================================
# LOAD INITIAL DATA FROM JSON
# =========================================

def load_destinations_from_json():
    """
    Load destination data from JSON file
    Image, lat, lon are now directly in the JSON file!

    Returns:
        list: List of destination dictionaries with complete information
    """
    json_file = os.path.join(basedir, 'all_destinations_complete.json')

    # Check if JSON file exists
    if not os.path.exists(json_file):
        print(
            f"Warning: {json_file} not found. No initial data will be loaded.")
        return []

    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Convert JSON data to list of destination dictionaries
        destinations = []
        for key, value in data.items():
            # Get data field (contains all detailed info including image, lat, lon)  # noqa: E501
            data_field = value.get("data", {})

            # Get detailed description and create short desc
            detailed_desc = data_field.get("detailed_description", "")
            short_desc = detailed_desc[:200] + \
                "..." if len(detailed_desc) > 200 else detailed_desc

            # Build destination dictionary - everything from JSON!
            dest = {
                # Basic info from top level
                "name": value.get("name"),
                "city": value.get("city"),
                "category": value.get("category"),

                # Image and coordinates - now directly from JSON data field!
                "image": data_field.get("image", ""),
                "lat": data_field.get("lat", 0.0),
                "lon": data_field.get("lon", 0.0),

                # Description
                "desc": short_desc,

                # All detailed information
                "opening_hours": data_field.get("opening_hours"),
                "admission_adult": data_field.get("admission_adult"),
                "admission_child": data_field.get("admission_child"),
                "admission_notes": data_field.get("admission_notes"),
                "phone": data_field.get("phone"),
                "website": data_field.get("website"),
                "email": data_field.get("email"),
                "transport_train": data_field.get("transport_train"),
                "transport_bus": data_field.get("transport_bus"),
                "transport_car": data_field.get("transport_car"),
                "visit_duration": data_field.get("visit_duration"),
                "best_time_to_visit": data_field.get("best_time_to_visit"),
                "detailed_description": data_field.get("detailed_description"),
                "history": data_field.get("history"),

                # Convert lists to JSON strings for database storage
                "tips": json.dumps(data_field.get("tips", [])) if data_field.get("tips") else None,  # noqa: E501
                "facilities": json.dumps(data_field.get("facilities", [])) if data_field.get("facilities") else None,  # noqa: E501
            }

            destinations.append(dest)

        print(f"âœ“ Loaded {len(destinations)} destinations from JSON file.")
        return destinations

    except json.JSONDecodeError as e:
        print(f"Error parsing JSON file: {e}")
        return []
    except Exception as e:
        print(f"Error loading destinations from JSON: {e}")
        return []


def init_db():
    """Initialize database with data from JSON file"""
    if Destination.query.count() == 0:
        # Load destinations from JSON file
        destinations_data = load_destinations_from_json()

        if not destinations_data:
            print("No destination data found. Database not seeded.")
            return

        # Add destinations to database
        for d in destinations_data:
            new_dest = Destination(
                name=d.get("name"),
                city=d.get("city"),
                category=d.get("category"),
                image=d.get("image"),
                desc=d.get("desc"),
                lat=d.get("lat"),
                lon=d.get("lon"),
                opening_hours=d.get("opening_hours"),
                admission_adult=d.get("admission_adult"),
                admission_child=d.get("admission_child"),
                admission_notes=d.get("admission_notes"),
                phone=d.get("phone"),
                website=d.get("website"),
                email=d.get("email"),
                transport_train=d.get("transport_train"),
                transport_bus=d.get("transport_bus"),
                transport_car=d.get("transport_car"),
                visit_duration=d.get("visit_duration"),
                best_time_to_visit=d.get("best_time_to_visit"),
                detailed_description=d.get("detailed_description"),
                history=d.get("history"),
                tips=d.get("tips"),
                facilities=d.get("facilities"),
            )
            db.session.add(new_dest)

        db.session.commit()
        print(f"âœ“ Database seeded with {len(destinations_data)} destinations.")

    # Initialize featured trips
    init_featured_trips()


# =========================================
# PASSWORD RESET HELPER FUNCTIONS
# =========================================


def send_password_reset_email(user, reset_url):
    """
    Send password reset email to user

    In a production environment, this would use a real email service like:
    - SendGrid
    - Amazon SES
    - Mailgun

    For development/demo purposes, we log the reset link to console
    """
    print("=" * 80)
    print(f"PASSWORD RESET EMAIL FOR: {user.email}")
    print(f"Username: {user.username}")
    print(f"Reset Link: {reset_url}")
    print("This link will expire in 1 hour")
    print("=" * 80)

    return True


# =========================================
# 4. ROUTES
# =========================================


@app.route("/")
def home():
    destinations = Destination.query.limit(6).all()
    return render_template("home.html", destinations=destinations)


@app.route("/destinations")
def destinations():
    page = request.args.get("page", 1, type=int)
    search_query = request.args.get("q", "").strip()
    active_category = request.args.get("category", "All")
    current_country = request.args.get("country", "All")

    query = Destination.query

    if search_query:
        search_pattern = f"%{search_query}%"
        query = query.filter(
            db.or_(
                Destination.name.ilike(search_pattern),
                Destination.city.ilike(search_pattern),
                Destination.desc.ilike(search_pattern),
            )
        )

    if active_category != "All":
        query = query.filter(Destination.category == active_category)

    if current_country != "All":
        query = query.filter(Destination.city.contains(current_country))

    pagination = query.paginate(page=page, per_page=9, error_out=False)

    all_cities = db.session.query(Destination.city).distinct().all()
    countries = sorted(
        set([city[0].split(",")[-1].strip() for city in all_cities if city[0]])
    )

    return render_template(
        "destinations.html",
        destinations=pagination.items,
        pagination=pagination,
        search_query=search_query,
        active_category=active_category,
        current_country=current_country,
        countries=countries,
    )


@app.route("/destination/<int:dest_id>")
def destination_detail(dest_id):
    destination = Destination.query.get_or_404(dest_id)
    reviews = (
        Review.query.filter_by(destination_id=dest_id)
        .order_by(Review.created_at.desc())
        .all()
    )

    user_review = None
    is_liked = False
    if current_user.is_authenticated:
        user_review = Review.query.filter_by(
            user_id=current_user.id, destination_id=dest_id
        ).first()
        # Check if destination is in user's favorites
        is_liked = destination in current_user.favorites

    return render_template(
        "destination_detail.html",
        destination=destination,
        reviews=reviews,
        user_review=user_review,
        is_liked=is_liked,
    )


@app.route("/destination/<int:dest_id>/review", methods=["POST"])
@login_required
def submit_review(dest_id):
    """
    Submit or update a review for a destination
    
    Args:
        dest_id (int): Destination ID
        
    Returns:
        Redirect to destination detail page
    """
    try:
        # Verify destination exists
        destination = Destination.query.get_or_404(dest_id)
        
        # Get form data
        rating = request.form.get("rating", type=int)
        comment = request.form.get("comment", "").strip()
        
        # Detailed logging for debugging
        app.logger.info(f"[Review] User {current_user.id} submitting review for destination {dest_id}")
        app.logger.info(f"[Review] Rating: {rating}, Comment length: {len(comment) if comment else 0}")
        
        # Validate rating exists
        if not rating:
            app.logger.warning(f"[Review] Missing rating from user {current_user.id}")
            flash("Please select a rating (1-5 stars)", "error")
            return redirect(url_for("destination_detail", dest_id=dest_id))
        
        # Validate rating range
        if rating < 1 or rating > 5:
            app.logger.warning(f"[Review] Invalid rating {rating} from user {current_user.id}")
            flash("Rating must be between 1 and 5 stars", "error")
            return redirect(url_for("destination_detail", dest_id=dest_id))
        
        # Sanitize comment content
        if comment:
            comment = sanitize_input(comment, max_length=1000)
        
        # Check if user already has a review for this destination
        existing_review = Review.query.filter_by(
            user_id=current_user.id,
            destination_id=dest_id
        ).first()
        
        if existing_review:
            # Update existing review
            app.logger.info(f"[Review] Updating existing review {existing_review.id}")
            existing_review.rating = rating
            existing_review.comment = comment
            existing_review.created_at = datetime.utcnow()
            
            flash_message = "Your review has been updated successfully!"
            log_action = "update_review"
        else:
            # Create new review
            app.logger.info(f"[Review] Creating new review")
            new_review = Review(
                user_id=current_user.id,
                destination_id=dest_id,
                rating=rating,
                comment=comment
            )
            db.session.add(new_review)
            
            flash_message = "Thank you for your review!"
            log_action = "create_review"
        
        # Commit to database
        try:
            db.session.commit()
            app.logger.info(f"[Review] Successfully saved review to database")
            
            # Log activity for audit trail
            log_activity(
                action_type=log_action,
                action_category="review",
                description=f"Review for {destination.name}",
                user=current_user,
                details={
                    "destination_id": dest_id,
                    "rating": rating,
                    "has_comment": bool(comment)
                },
                status="success"
            )
            
            flash(flash_message, "success")
            
        except Exception as commit_error:
            # Rollback on commit failure
            db.session.rollback()
            app.logger.error(f"[Review] Database commit failed: {str(commit_error)}")
            app.logger.error(f"[Review] Error type: {type(commit_error).__name__}")
            
            # Log full traceback for debugging
            import traceback
            app.logger.error(f"[Review] Traceback: {traceback.format_exc()}")
            
            flash("Failed to save your review. Please try again.", "error")
            
    except Exception as e:
        # Handle unexpected errors
        db.session.rollback()
        app.logger.error(f"[Review] Unexpected error: {str(e)}")
        
        # Log full traceback
        import traceback
        app.logger.error(f"[Review] Traceback: {traceback.format_exc()}")
        
        flash("An unexpected error occurred. Please try again.", "error")
    
    # Always redirect back to destination detail page
    return redirect(url_for("destination_detail", dest_id=dest_id))


@app.route("/api/trips", methods=["GET", "POST"])
@login_required
def api_trips():
    if request.method == "POST":
        data = request.get_json()
        title = sanitize_input(data.get("title", "My Trip"))
        stops = data.get("stops", [])

        new_trip = Trip(user_id=current_user.id, title=title)
        db.session.add(new_trip)
        db.session.flush()

        for idx, stop in enumerate(stops):
            trip_stop = TripStop(
                trip_id=new_trip.id,
                destination_name=stop.get("name"),
                lat=stop.get("lat"),
                lon=stop.get("lon"),
                order=idx,
            )
            db.session.add(trip_stop)

        db.session.commit()

        return jsonify(
            {
                "status": "success",
                "trip_id": new_trip.id,
                "message": "Trip saved successfully!",
            }
        )

    else:
        trips = (
            Trip.query.filter_by(user_id=current_user.id)
            .order_by(Trip.created_at.desc())
            .all()
        )
        trips_data = []
        for trip in trips:
            trips_data.append(
                {
                    "id": trip.id,
                    "title": trip.title,
                    "created_at": trip.created_at.strftime("%B %d, %Y"),
                    "stops_count": len(trip.stops),
                }
            )
        return jsonify(trips_data)


@app.route("/api/trips/<int:trip_id>", methods=["GET", "DELETE", "PATCH"])
@login_required
def api_trip_detail(trip_id):
    trip = Trip.query.get_or_404(trip_id)

    if trip.user_id != current_user.id:
        return jsonify({"error": "Unauthorized"}), 403

    if request.method == "DELETE":
        db.session.delete(trip)
        db.session.commit()
        return jsonify({"status": "success", "message": "Trip deleted"})

    elif request.method == "PATCH":
        data = request.get_json()
        if "is_public" in data:
            trip.is_public = data["is_public"]
            db.session.commit()
            return jsonify({"status": "success", "is_public": trip.is_public})

    else:
        stops_data = []
        for stop in sorted(trip.stops, key=lambda x: x.order):
            stops_data.append(
                {
                    "name": stop.destination_name,
                    "lat": stop.lat,
                    "lon": stop.lon,
                    "order": stop.order,
                }
            )

        return jsonify(
            {
                "id": trip.id,
                "title": trip.title,
                "is_public": trip.is_public,
                "stops": stops_data,
            }
        )


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("home"))

    if request.method == "POST":
        email = sanitize_input(request.form.get("email"))
        password = request.form.get("password")
        remember = request.form.get("remember") == "on"  # è¯»å–ç”¨æˆ·çš„Remember Meé€‰æ‹©

        if not email or not password:
            log_security_event(
                event_type="login_failed",
                description="Login attempt with missing credentials",
                severity="info",
            )
            flash("Please enter both email and password", "error")
            return render_template("login.html")

        user = User.query.filter_by(email=email).first()

        if user and user.check_password(password):
            if not user.is_active:
                log_security_event(
                    event_type="login_blocked",
                    description=f"Inactive user attempted login: {email}",
                    user=user,
                    severity="warning",
                )
                flash(
                    "Your account has been deactivated. Please contact support.",  # noqa: E501
                    "error",
                )
                return render_template("login.html")

            login_user(user, remember=remember)  # ä½¿ç”¨ç”¨æˆ·é€‰æ‹©çš„rememberå€¼
            user.last_login = datetime.utcnow()
            db.session.commit()

            log_activity(
                action_type="login",
                action_category="auth",
                description="User logged in successfully",
                user=user,
                details={"email": email, "method": "password"},
                status="success",
            )

            next_page = request.args.get("next")
            flash(f"Welcome back, {user.username}!", "success")
            return redirect(next_page if next_page else url_for("home"))
        else:
            log_security_event(
                event_type="login_failed",
                description=f"Failed login attempt for email: {email}",
                user=user if user else None,
                severity="warning",
            )
            flash("Invalid username or password", "error")

    return render_template("login.html")


# =========================================
# PASSWORD RESET ROUTES
# =========================================


@app.route("/forgot-password", methods=["GET", "POST"])
def forgot_password():
    """Handle password reset request"""
    if current_user.is_authenticated:
        return redirect(url_for("home"))

    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()

        if not email:
            flash("Please enter your email address", "error")
            return render_template("forgot_password.html")

        # Always show success message to prevent email enumeration attacks
        flash(
            "If an account exists with this email, you will receive password reset instructions.",  # noqa: E501
            "success",
        )

        # Find user by email
        user = User.query.filter_by(email=email).first()

        if user:
            # Generate reset token
            token = user.generate_reset_token()
            db.session.commit()

            # Create reset URL
            reset_url = url_for("reset_password", token=token, _external=True)

            # Send email (in production)
            send_password_reset_email(user, reset_url)

        # Redirect to login page after showing message
        return redirect(url_for("login"))

    return render_template("forgot_password.html")


@app.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token):
    """Handle password reset with token"""
    if current_user.is_authenticated:
        return redirect(url_for("home"))

    # Find user with this token
    user = User.query.filter_by(reset_token=token).first()

    if not user or not user.verify_reset_token(token):
        flash(
            "Invalid or expired reset link. Please request a new one.", "error"
        )
        return redirect(url_for("forgot_password"))

    if request.method == "POST":
        password = request.form.get("password")
        confirm_password = request.form.get("confirm_password")

        # Validate password
        is_valid_password, password_error = validate_password(password)
        if not is_valid_password:
            flash(password_error, "error")
            return render_template("reset_password.html", token=token)

        # Check passwords match
        if password != confirm_password:
            flash("Passwords do not match", "error")
            return render_template("reset_password.html", token=token)

        # Update password
        user.set_password(password)
        user.clear_reset_token()
        db.session.commit()

        flash(
            "Your password has been reset successfully! You can now log in.",
            "success",
        )
        return redirect(url_for("login"))

    return render_template("reset_password.html", token=token)


@app.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("home"))

    if request.method == "POST":
        username = sanitize_input(request.form.get("username"))
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password")
        confirm_password = request.form.get("confirm_password")

        is_valid_username, username_error = validate_username(username)
        if not is_valid_username:
            log_activity(
                action_type="registration_failed",
                action_category="auth",
                description=f"Registration failed: {username_error}",
                details={"username": username, "reason": "invalid_username"},
                status="failed",
            )
            flash(username_error, "error")
            return render_template("register.html")

        is_valid_email, email_error = validate_email(email)
        if not is_valid_email:
            log_activity(
                action_type="registration_failed",
                action_category="auth",
                description=f"Registration failed: {email_error}",
                details={"email": email, "reason": "invalid_email"},
                status="failed",
            )
            flash(email_error, "error")
            return render_template("register.html")

        is_valid_password, password_error = validate_password(password)
        if not is_valid_password:
            log_activity(
                action_type="registration_failed",
                action_category="auth",
                description=f"Registration failed: {password_error}",
                details={"username": username, "reason": "invalid_password"},
                status="failed",
            )
            flash(password_error, "error")
            return render_template("register.html")

        if password != confirm_password:
            log_activity(
                action_type="registration_failed",
                action_category="auth",
                description="Registration failed: Password mismatch",
                details={"username": username, "reason": "password_mismatch"},
                status="failed",
            )
            flash("Passwords do not match", "error")
            return render_template("register.html")

        existing_user = User.query.filter_by(username=username).first()
        if existing_user:
            log_activity(
                action_type="registration_failed",
                action_category="auth",
                description="Registration failed: Username already exists",
                details={"username": username, "reason": "duplicate_username"},
                status="failed",
            )
            flash("Username already taken. Please choose another.", "error")
            return render_template("register.html")

        existing_email = User.query.filter_by(email=email).first()
        if existing_email:
            log_activity(
                action_type="registration_failed",
                action_category="auth",
                description="Registration failed: Email already registered",
                details={"email": email, "reason": "duplicate_email"},
                status="failed",
            )
            flash(
                "Email already registered. Please use another or login.",
                "error",
            )
            return render_template("register.html")

        try:
            new_user = User(username=username, email=email)
            new_user.set_password(password)

            db.session.add(new_user)
            db.session.commit()

            log_activity(
                action_type="registration",
                action_category="auth",
                description=f"New user registered: {username}",
                user=new_user,
                details={"username": username, "email": email},
                status="success",
            )

            flash("Registration successful! Welcome to Voyager!", "success")
            return redirect(url_for("login"))

        except Exception as e:
            db.session.rollback()
            log_activity(
                action_type="registration_error",
                action_category="auth",
                description=f"Registration error: {str(e)}",
                details={"username": username, "error": str(e)},
                status="error",
            )
            print(f"Registration error: {e}")
            flash(
                "An error occurred during registration. Please try again.",
                "error",
            )
            return render_template("register.html")

    return render_template("register.html")


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    log_activity(
        action_type="logout",
        action_category="auth",
        description="User logged out",
        user=current_user,
        status="success",
    )
    logout_user()
    flash("You have been logged out.", "success")
    return redirect(url_for("home"))


@app.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    """
    User profile page with avatar upload functionality
    Enhanced to handle avatar-only uploads
    """
    # Get the current user's latest database object
    user = db.session.query(User).get(current_user.id)

    if request.method == "POST":
        try:
            # Get form data
            new_username = request.form.get("username", "").strip()
            new_email = request.form.get("email", "").strip()
            new_bio = request.form.get("bio", "").strip()

            # éªŒè¯bioé•¿åº¦
            if len(new_bio) > 500:
                flash("Bio is too long (maximum 500 characters)", "error")
                return redirect(url_for("profile"))

            # CRITICAL FIX: Check if this is an avatar-only upload
            # If form fields are empty BUT avatar is provided, use current user
            # values
            avatar_file = request.files.get("avatar")
            is_avatar_only_upload = (
                avatar_file
                and avatar_file.filename != ""
                and (not new_username or not new_email)
            )

            if is_avatar_only_upload:
                app.logger.info(
                    "Avatar-only upload detected. Using existing user data."
                )
                new_username = user.username
                new_email = user.email
                new_bio = user.bio if not new_bio else new_bio

            # Validation - but now with better messages
            if not new_username:
                app.logger.error(
                    f"Username validation failed. Received: '{request.form.get('username')}'"  # noqa: E501
                )
                app.logger.error(
                    f"Form data keys: {list(request.form.keys())}"
                )
                flash(
                    "Username cannot be empty. Please fill in the profile form.",  # noqa: E501
                    "error",
                )
                return redirect(url_for("profile"))

            if not new_email:
                app.logger.error(
                    f"Email validation failed. Received: '{request.form.get('email')}'"  # noqa: E501
                )
                flash(
                    "Email cannot be empty. Please fill in the profile form.",
                    "error",
                )
                return redirect(url_for("profile"))

            # Email format validation - ä½¿ç”¨å®Œå–„çš„éªŒè¯å‡½æ•°
            is_valid_email, email_error = validate_email(new_email)
            if not is_valid_email:
                flash(email_error, "error")
                return redirect(url_for("profile"))

            # 1. Validate username uniqueness (only if changed)
            if new_username != user.username:
                existing_user = User.query.filter_by(
                    username=new_username
                ).first()
                if existing_user:
                    flash("Username already taken", "error")
                    return redirect(url_for("profile"))

            # 2. Validate email uniqueness (only if changed)
            if new_email != user.email:
                existing_email = User.query.filter_by(email=new_email).first()
                if existing_email:
                    flash("Email already registered", "error")
                    return redirect(url_for("profile"))

            # Update basic information
            user.username = new_username
            user.email = new_email
            user.bio = new_bio

            # 3. Handle avatar upload
            avatar_uploaded = False
            if avatar_file and avatar_file.filename != "":
                app.logger.info(
                    f"Avatar upload attempt - filename: {avatar_file.filename}"
                )

                # Validate file type
                if not allowed_file(avatar_file.filename):
                    flash(
                        "Invalid file type. Please upload PNG, JPG, GIF, or WEBP.",  # noqa: E501
                        "error",
                    )
                    return redirect(url_for("profile"))

                try:
                    # Ensure upload directory exists
                    upload_dir = os.path.join(basedir, "static", "uploads")
                    os.makedirs(upload_dir, exist_ok=True)
                    app.logger.info(f"Upload directory: {upload_dir}")

                    # Verify directory is writable
                    if not os.access(upload_dir, os.W_OK):
                        app.logger.error(
                            f"Upload directory not writable: {upload_dir}"
                        )
                        flash(
                            "Server configuration error. Please contact support.",  # noqa: E501
                            "error",
                        )
                        return redirect(url_for("profile"))

                    # Delete old avatar if it exists and is not the default
                    if user.avatar and "Default_Avatar.png" not in user.avatar:
                        old_path = os.path.join(
                            basedir, user.avatar.lstrip("/")
                        )
                        if os.path.exists(old_path) and os.path.isfile(
                            old_path
                        ):
                            try:
                                os.remove(old_path)
                                app.logger.info(
                                    f"Deleted old avatar: {old_path}"
                                )
                            except Exception as e:
                                app.logger.warning(
                                    f"Could not delete old avatar: {e}"
                                )

                    # Generate new filename
                    ext = avatar_file.filename.rsplit(".", 1)[1].lower()
                    new_filename = f"avatar_{user.id}_{int(time.time())}_{uuid.uuid4().hex[:8]}.{ext}"  # noqa: E501
                    file_path = os.path.join(upload_dir, new_filename)

                    # Save file
                    avatar_file.save(file_path)
                    app.logger.info(f"Saved avatar to: {file_path}")

                    # Verify file was saved
                    if not os.path.exists(file_path):
                        raise Exception("File save verification failed")

                    # Update user avatar path
                    user.avatar = f"/static/uploads/{new_filename}"
                    avatar_uploaded = True
                    app.logger.info(f"Updated user.avatar to: {user.avatar}")

                except Exception as e:
                    app.logger.error(f"Avatar upload error: {str(e)}")
                    import traceback

                    app.logger.error(traceback.format_exc())
                    flash("Error uploading avatar. Please try again.", "error")
                    db.session.rollback()
                    return redirect(url_for("profile"))

            # 4. Commit database changes
            try:
                # Track what changed for logging
                changes = {}
                if new_username != user.username:
                    changes["username"] = {
                        "old": user.username,
                        "new": new_username,
                    }
                if new_email != user.email:
                    changes["email"] = {"old": user.email, "new": new_email}
                if new_bio != user.bio:
                    changes["bio"] = "updated"
                if avatar_uploaded:
                    changes["avatar"] = "updated"

                db.session.commit()
                app.logger.info(
                    "Successfully committed profile changes to database"
                )

                # Log profile update
                log_activity(
                    action_type="profile_update",
                    action_category="profile",
                    description="User updated profile",
                    user=user,
                    details=changes,
                    status="success",
                )

                if avatar_uploaded:
                    flash(
                        "Profile and avatar updated successfully!", "success"
                    )
                else:
                    flash("Profile updated successfully!", "success")

            except Exception as e:
                db.session.rollback()
                app.logger.error(f"Database commit error: {str(e)}")
                import traceback

                app.logger.error(traceback.format_exc())

                log_activity(
                    action_type="profile_update_error",
                    action_category="profile",
                    description=f"Profile update failed: {str(e)}",
                    user=user,
                    status="error",
                )

                flash("Error saving changes. Please try again.", "error")

            return redirect(url_for("profile"))

        except Exception as e:
            db.session.rollback()
            app.logger.error(f"Unexpected error in profile route: {str(e)}")
            import traceback

            app.logger.error(traceback.format_exc())
            flash("An unexpected error occurred. Please try again.", "error")
            return redirect(url_for("profile"))

    # GET request - display profile page
    try:
        my_trips = (
            Trip.query.filter_by(user_id=current_user.id)
            .order_by(Trip.created_at.desc())
            .all()
        )
        saved_destinations = current_user.favorites
        favorite_trips = current_user.favorite_trips

        return render_template(
            "profile.html",
            user=user,
            my_trips=my_trips,
            saved_destinations=saved_destinations,
            favorite_trips=favorite_trips,
        )
    except Exception as e:
        app.logger.error(f"Error loading profile page: {str(e)}")
        flash("Error loading profile. Please try again.", "error")
        return redirect(url_for("index"))


@app.route("/api/like/<int:dest_id>", methods=["POST"])
@login_required
def api_like_destination_v2(dest_id):
    dest = Destination.query.get_or_404(dest_id)

    data = request.get_json(silent=True) or {}
    requested_action = data.get("action")

    is_liked = dest in current_user.favorites
    action_performed = "no_change"

    if requested_action == "like":
        if not is_liked:
            current_user.favorites.append(dest)
            action_performed = "added"
            is_liked = True
    elif requested_action == "unlike":
        if is_liked:
            current_user.favorites.remove(dest)
            action_performed = "removed"
            is_liked = False
    else:
        if is_liked:
            current_user.favorites.remove(dest)
            action_performed = "removed"
            is_liked = False
        else:
            current_user.favorites.append(dest)
            action_performed = "added"
            is_liked = True

    db.session.commit()

    return jsonify(
        {
            "status": "success",
            "action": action_performed,
            "liked": is_liked,
            "likeCount": len(dest.favorited_by),
            "dest_name": dest.name,
        }
    )


# =========================================
# Recommendation System API
# =========================================


@app.route("/api/recommendations")
@login_required
def api_recommendations():
    """
    Enhanced recommendation API - with complete error handling and logging
    """
    try:
        # Detailed debug logging
        print(f"\n{'=' * 50}")
        print(
            f"[REC API] Recommendation request from user: {current_user.username} (ID: {current_user.id})"  # noqa: E501
        )
        print(f"[REC API] User favorites count: {len(current_user.favorites)}")

        # If user has favoritesï¼ŒShow sample
        if current_user.favorites:
            fav_names = [d.name for d in current_user.favorites[:3]]
            print(f"[REC API] Favorites sample: {fav_names}")

        # Initialize recommendation engine
        print("[REC API] Initializing recommendation engine...")
        engine = RecommendationEngine()

        # Get personalized recommendations
        print("[REC API] Generating recommendations...")
        result = engine.get_recommendations(current_user, limit=3)

        # Log results
        print(f"[REC API] Recommendation type: {result.get('type')}")
        print(
            f"[REC API] Found destinations: {len(result.get('destinations', []))}"  # noqa: E501
        )

        if result.get("destinations"):
            dest_names = [d["name"] for d in result["destinations"]]
            print(f"[REC API] Recommended destinations: {dest_names}")

        print(f"{'=' * 50}\n")

        return jsonify(result), 200

    except Exception as e:
        # Comprehensive error logging
        import traceback

        print(f"\n{'=' * 50}")
        print("[Error] Recommendation engine failed!")
        print(f"[Error] Exception type: {type(e).__name__}")
        print(f"[Error] Exception message: {str(e)}")
        print("[Error] Stack trace:")
        print(traceback.format_exc())
        print(f"{'=' * 50}\n")

        # Fallback to backup recommendations
        return _get_fallback_recommendations()


def _get_fallback_recommendations():
    """
    Enhanced fallback recommendation logic
    Returns popular destinations when main engine fails
    """
    try:
        print("[Fallback] Using fallback recommendation logic...")

        fav_ids = (
            [d.id for d in current_user.favorites]
            if current_user.favorites
            else []
        )
        print(f"[Fallback] Excluding {len(fav_ids)} usersæ”¶è—")

        # Query available destinations
        if fav_ids:
            candidates = Destination.query.filter(
                Destination.id.notin_(fav_ids)
            ).all()
        else:
            candidates = Destination.query.all()

        print(f"[Fallback] Found {len(candidates)} candidate destinations")

        if not candidates:
            print("[Fallback] No available candidates - returning empty")
            return (
                jsonify(
                    {
                        "type": "popular",
                        "message": "No destinations available",
                        "destinations": [],
                    }
                ),
                200,
            )

        # Sort by rating
        candidates.sort(key=lambda x: x.get_avg_rating() or 0, reverse=True)
        recommendations = candidates[:3]

        # Format response
        dest_list = []
        for d in recommendations:
            rating = d.get_avg_rating() or 0
            reviews_count = len(d.reviews) if d.reviews else 0

            dest_list.append(
                {
                    "id": d.id,
                    "name": d.name,
                    "city": d.city,
                    "category": d.category,
                    "image": d.image or "/static/img/placeholder.jpg",
                    "rating": rating,
                    "reviews_count": reviews_count,
                    "desc": d.desc or "Explore this amazing destination",
                    "reasons": [
                        (
                            "Highly rated destination"
                            if rating >= 4.0
                            else "Popular destination"
                        ),
                        (
                            f"Recommended by {reviews_count} travelers"
                            if reviews_count > 0
                            else "Great for first-time visitors"
                        ),
                    ],
                    "recommendation_score": min(95, int(rating * 19)),
                }
            )

        print(f"[Fallback] Returning {len(dest_list)} recommendations")

        return (
            jsonify(
                {
                    "type": "popular",
                    "message": "Popular destinations for you",
                    "destinations": dest_list,
                }
            ),
            200,
        )

    except Exception as e:
        print(f"[Error] Fallback also failed: {e}")
        import traceback

        print(traceback.format_exc())

        # Ultimate fallback - empty but valid response
        return (
            jsonify(
                {
                    "type": "error",
                    "message": "Unable to load recommendations at this time",
                    "destinations": [],
                }
            ),
            200,
        )


# =========================================
# Debug endpoint
# =========================================


@app.route("/api/debug/recommendations")
@login_required
def debug_recommendations():
    """Debug endpoint - test recommendation system status"""
    return jsonify(
        {
            "user": {
                "id": current_user.id,
                "username": current_user.username,
                "favorites_count": len(current_user.favorites),
                "favorites": [
                    {"id": d.id, "name": d.name}
                    for d in current_user.favorites
                ],
            },
            "database": {
                "total_destinations": Destination.query.count(),
                "total_users": User.query.count(),
                "total_reviews": Review.query.count(),
            },
            "engine_status": "OK",
        }
    )


# =========================================
# SAVE TRIP API
# =========================================


@app.route("/api/save_trip", methods=["POST"])
@login_required
def save_trip():
    """
    Save user-created trip from Trip Planner to database

    Receives tripData from frontend:
    {
        name: "My Road Trip",
        days: [
            {
                id: 1234567890,
                number: 1,
                name: "Day 1",
                stops: [
                    {
                        id: 1234567891,
                        name: "Big Ben",
                        fullName: "Big Ben, London, UK",
                        lat: 51.5007,
                        lon: -0.1246,
                        type: "attraction",
                        arrival: "10:00",
                        duration: 1,
                        notes: "Visit the clock tower",
                        budget: 15
                    }
                ]
            }
        ],
        region: "uk"
    }
    """
    try:
        data = request.get_json()

        # 1. Validate required fields
        if not data:
            return (
                jsonify({"status": "error", "message": "No data provided"}),
                400,
            )

        trip_name = data.get("name", "").strip()
        if not trip_name:
            return (
                jsonify(
                    {"status": "error", "message": "Trip name is required"}
                ),
                400,
            )

        # Validate trip name length (min: 3, max: 100 characters)
        if len(trip_name) < 3:
            return (
                jsonify(
                    {"status": "error",
                        "message": "Trip name must be at least 3 characters long"}  # noqa: E501
                ),
                400,
            )
        if len(trip_name) > 100:
            return (
                jsonify(
                    {"status": "error", "message": "Trip name cannot exceed 100 characters"}  # noqa: E501
                ),
                400,
            )

        days = data.get("days", [])
        if not days or len(days) == 0:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "Trip must have at least one day with stops",  # noqa: E501
                    }
                ),
                400,
            )

        # Validate if there are any stops
        total_stops = sum(len(day.get("stops", [])) for day in days)
        if total_stops == 0:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "Trip must have at least one stop",
                    }
                ),
                400,
            )

        # Validate maximum number of stops (limit: 50)
        if total_stops > 50:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": f"Trip cannot have more than 50 stops. Current: {total_stops}",  # noqa: E501
                    }
                ),
                400,
            )

        # 2. Create Trip object
        new_trip = Trip(
            user_id=current_user.id,
            title=trip_name,
            name=trip_name,
            region=data.get("region", "world"),
            data=json.dumps(days),
            total_stops=total_stops,
            is_public=False,
        )
        db.session.add(new_trip)
        db.session.flush()  # Get trip.id

        # 3. Save all stops (in order)
        order_counter = 1

        for day_index, day in enumerate(days, 1):
            stops = day.get("stops", [])

            for stop in stops:
                # Extract stop information
                stop_name = stop.get("name", "Unnamed Stop")
                if not stop_name or stop_name == "":
                    stop_name = stop.get("fullName", "Unnamed Stop").split(
                        ","
                    )[0]

                lat = stop.get("lat")
                lon = stop.get("lon")

                # Validate coordinates existence
                if lat is None or lon is None:
                    continue  # Skip stops without coordinates

                # Validate coordinate types and ranges
                try:
                    lat = float(lat)
                    lon = float(lon)

                    # Validate latitude range (-90 to 90)
                    if lat < -90 or lat > 90:
                        print(
                            f"Warning: Invalid latitude {lat} for stop {stop_name}, skipping")  # noqa: E501
                        continue

                    # Validate longitude range (-180 to 180)
                    if lon < -180 or lon > 180:
                        print(
                            f"Warning: Invalid longitude {lon} for stop {stop_name}, skipping")  # noqa: E501
                        continue

                except (ValueError, TypeError):
                    print(
                        f"Warning: Invalid coordinate format for stop {stop_name}, skipping")  # noqa: E501
                    continue

                # Create TripStop
                trip_stop = TripStop(
                    trip_id=new_trip.id,
                    destination_name=stop_name,
                    lat=lat,  # Already validated and converted to float
                    lon=lon,  # Already validated and converted to float
                    order=order_counter,
                )
                db.session.add(trip_stop)
                order_counter += 1

        # 4. Commit to database
        db.session.commit()

        # Log trip creation
        log_activity(
            action_type="create_trip",
            action_category="trip",
            description=f"Created new trip: {trip_name}",
            user=current_user,
            details={
                "trip_id": new_trip.id,
                "trip_name": trip_name,
                "stops_count": order_counter - 1,
                "region": "",
            },
            status="success",
        )

        return (
            jsonify(
                {
                    "status": "success",
                    "trip_id": new_trip.id,
                    "message": "Trip saved successfully!",
                    "stops_count": order_counter - 1,
                    "redirect_url": url_for("profile"),
                }
            ),
            200,
        )

    except Exception as e:
        db.session.rollback()
        print(f"[ERROR] Failed to save trip: {e}")
        import traceback

        print(traceback.format_exc())

        log_activity(
            action_type="create_trip_error",
            action_category="trip",
            description=f"Failed to create trip: {str(e)}",
            user=current_user,
            details={"error": str(e)},
            status="error",
        )

        return (
            jsonify(
                {
                    "status": "error",
                    "message": "Failed to save trip to database. Please try again.",  # noqa: E501
                }
            ),
            500,
        )


# =========================================
# 6. Other routes
# =========================================


@app.route("/planner")
@login_required
def planner():
    destinations = Destination.query.all()
    return render_template("planner.html", destinations=destinations)


def get_featured_image(featured_key):
    """Return corresponding image path based on featured_key"""
    image_map = {
        "route_1_london": "img/London_Architecture.avif",
        "route_2_kyoto": "img/Kyoto_Streets.avif",
        "route_3_paris": "img/Seine_River.jpg",
    }
    return image_map.get(featured_key, "img/default.jpg")


def get_trip_city(trip):
    """Get city information from trip's stops"""
    if trip.stops and len(trip.stops) > 0:
        # Return first stop's city
        first_stop = trip.stops[0]
        if hasattr(first_stop, "city"):
            return first_stop.city
        # Extract city from destination_name (if comma-separated)
        if "," in first_stop.destination_name:
            return first_stop.destination_name.split(",")[-1].strip()
    return "Multiple Cities"


def get_trip_description(trip):
    """Get trip description"""
    # Featured route description mapping
    descriptions = {
        "route_1_london": "A 6-stop royal tour featuring Big Ben, Westminster Abbey, and Buckingham Palace.",  # noqa: E501
        "route_2_kyoto": "Explore Kyoto's soul through iconic shrines, historic slopes, and the atmospheric Gion district.",  # noqa: E501
        "route_3_paris": "A magical evening walk along the Seine, connecting the Eiffel Tower to the illuminated Louvre.",  # noqa: E501
    }

    # If featured route, return preset description
    if trip.is_featured and trip.featured_key:
        return descriptions.get(trip.featured_key, "")

    # If has description field
    if hasattr(trip, "description") and trip.description:
        return trip.description

    # Get from data JSON
    if trip.data:
        import json

        try:
            data = json.loads(trip.data)
            if "description" in data:
                return data["description"]
        except Exception:
            pass

    # Default description
    return f"Explore {len(trip.stops)} carefully selected destinations."


@app.route("/community")
def community():
    """Community hub showing both featured routes and user public trips"""

    # Get all featured routes from database
    featured_trips = (
        Trip.query.filter_by(is_featured=True).order_by(Trip.id).all()
    )

    # Add additional attributes for featured routes
    for trip in featured_trips:
        trip.image = get_featured_image(trip.featured_key)
        trip.city = get_trip_city(trip)
        trip.description = get_trip_description(trip)

    # Usermade publicTrip
    public_trips = (
        Trip.query.filter_by(is_public=True, is_featured=False)
        .order_by(Trip.created_at.desc())
        .all()
    )

    # Add attributes for user trips
    for trip in public_trips:
        trip.city = get_trip_city(trip)
        if not hasattr(trip, "description") or not trip.description:
            trip.description = get_trip_description(trip)

    # Merge lists (featured routes first)
    all_trips = featured_trips + public_trips

    return render_template("community.html", trips=all_trips)


@app.route("/toggle_public/<int:trip_id>", methods=["POST"])
@login_required
def toggle_public(trip_id):
    """Toggle the public/private status of a trip (è¿”å›žJSONå“åº”)"""
    trip = Trip.query.get_or_404(trip_id)

    # Verify ownership
    if trip.user_id != current_user.id:
        return jsonify({
            "success": False,
            "error": "You do not have permission to modify this trip."
        }), 403

    try:
        # Toggle the is_public status
        trip.is_public = not trip.is_public
        db.session.commit()

        status = "public" if trip.is_public else "private"

        return jsonify({
            "success": True,
            "message": f'Trip is now {status}!',
            "is_public": trip.is_public,
            "status": status
        }), 200
    except Exception:
        db.session.rollback()
        return jsonify({
            "success": False,
            "error": "Failed to update trip visibility. Please try again."
        }), 500


@app.route("/delete_trip/<int:trip_id>", methods=["POST", "DELETE"])
@login_required
def delete_trip_alias(trip_id):
    """Delete trip - alias route for compatibility"""
    return delete_trip(trip_id)


@app.route("/route/<string:trip_id>")
def route_detail(trip_id):
    """Display trip detail page"""

    print(f"\n{'=' * 60}")
    print(f"[Route Detail] Processing trip_id: {trip_id}")
    print(f"[Route Detail] Type: {type(trip_id)}")

    # ==========================================
    # FEATURED ROUTES HANDLING
    # ==========================================
    if isinstance(trip_id, str) and trip_id.startswith("featured_"):
        print("[Route Detail] Detected featured route")

        # Map featured IDs to route keys
        route_map = {
            "featured_1": "route_1_london",
            "featured_2": "route_2_kyoto",
            "featured_3": "route_3_paris",
        }

        if trip_id not in route_map:
            flash("Featured route not found", "error")
            return redirect(url_for("community"))

        route_key = route_map[trip_id]
        print(f"[Route Detail] Loading route: {route_key}")

        # Load featured routes data from JSON
        featured_routes_data = load_featured_routes()

        if not featured_routes_data or route_key not in featured_routes_data:
            flash("Failed to load route data", "error")
            return redirect(url_for("community"))

        route_data = featured_routes_data[route_key]
        print(f"[Route Detail] Route data loaded: {route_data.get('title')}")

        # Convert to trip format (this adds routeFromPrevious and maps fields)
        trip_obj = convert_route_to_trip(route_data, trip_id)

        # Debug: Check first stop
        if trip_obj["days"] and trip_obj["days"][0]["stops"]:
            first_stop = trip_obj["days"][0]["stops"][0]
            print("\n[Route Detail] First stop data:")
            print(f"  Name: {first_stop.get('name')}")
            print(f"  Opening hours: {first_stop.get('opening_hours')}")
            print(f"  Admission: {first_stop.get('admission')}")
            print(f"  Tips count: {len(first_stop.get('tips', []))}")

            if len(trip_obj["days"][0]["stops"]) > 1:
                second_stop = trip_obj["days"][0]["stops"][1]
                print("\n[Route Detail] Second stop routing:")
                if second_stop.get("routeFromPrevious"):
                    print(
                        f"  Distance: {second_stop['routeFromPrevious'].get('distance')} km"  # noqa: E501
                    )
                    print(
                        f"  Duration: {second_stop['routeFromPrevious'].get('duration')} min"  # noqa: E501
                    )
                else:
                    print("  âŒ No routeFromPrevious found!")

        # Calculate total stops
        total_stops = sum(
            len(day.get("stops", [])) for day in trip_obj["days"]
        )

        print(f"[Route Detail] âœ“ Rendering template with {total_stops} stops")
        print(f"{'=' * 60}\n")

        return render_template(
            "route_detail.html",
            trip=trip_obj,
            total_stops=total_stops,
            is_featured=True,
            reviews=[],
            is_liked=False,
            is_favorited=False,
            trip_author=None,
            avg_rating=0,
            likes_count=0,
        )

    # ==========================================
    # USER TRIPS HANDLING
    # ==========================================
    print("[Route Detail] Processing as user trip")

    try:
        trip_id = int(trip_id)
    except ValueError:
        flash("Invalid trip ID", "error")
        return redirect(url_for("community"))

    trip = Trip.query.get_or_404(trip_id)

    # Permission check
    if not trip.is_public and not trip.is_featured:
        if (
            not current_user.is_authenticated
            or current_user.id != trip.user_id
        ):
            flash("You do not have permission to view this trip", "error")
            return redirect(url_for("profile"))

    # Parse trip data correctly
    if hasattr(trip, "data") and trip.data:
        try:
            days_data = json.loads(trip.data)
        except Exception as e:
            print(f"Error parsing trip data: {e}")
            days_data = []

        total_stops = sum(len(day.get("stops", [])) for day in days_data)

        trip_obj = {
            "id": trip.id,
            "name": getattr(trip, "name", None) or trip.title,
            "region": getattr(trip, "region", "world"),
            "created_at": (
                trip.created_at.strftime("%B %d, %Y")
                if hasattr(trip.created_at, "strftime")
                else str(trip.created_at)
            ),
            "is_public": trip.is_public,
            "days": days_data,
            "transport_mode": getattr(trip, "transport_mode", "foot-walking"),
            "estimated_duration": getattr(trip, "estimated_duration", None),
            "food_recommendations": [],
        }

    else:
        # Old format fallback
        stops = (
            TripStop.query.filter_by(trip_id=trip_id)
            .order_by(TripStop.order)
            .all()
        )

        if stops:
            days_data = [
                {
                    "id": 1,
                    "number": 1,
                    "name": "Day 1",
                    "stops": [
                        {
                            "id": i,
                            "name": stop.destination_name,
                            "fullName": stop.destination_name,
                            "lat": stop.lat,
                            "lon": stop.lon,
                            "type": "attraction",
                        }
                        for i, stop in enumerate(stops, 1)
                    ],
                }
            ]

            trip_obj = {
                "id": trip.id,
                "name": trip.title,
                "region": "world",
                "created_at": (
                    trip.created_at.strftime("%B %d, %Y")
                    if hasattr(trip.created_at, "strftime")
                    else str(trip.created_at)
                ),
                "is_public": trip.is_public,
                "days": days_data,
                "transport_mode": "foot-walking",
                "estimated_duration": None,
                "food_recommendations": [],
            }

            total_stops = len(stops)
        else:
            trip_obj = {
                "id": trip.id,
                "name": trip.title,
                "region": "world",
                "created_at": (
                    trip.created_at.strftime("%B %d, %Y")
                    if hasattr(trip.created_at, "strftime")
                    else str(trip.created_at)
                ),
                "is_public": trip.is_public,
                "days": [],
                "transport_mode": "foot-walking",
                "estimated_duration": None,
                "food_recommendations": [],
            }
            total_stops = 0

    # Get reviews and other data
    reviews = (
        TripReview.query.filter_by(trip_id=trip_id)
        .order_by(TripReview.created_at.desc())
        .all()
    )
    is_liked = (
        trip.is_liked_by(current_user)
        if current_user.is_authenticated
        else False
    )
    is_favorited = (
        trip.is_favorited_by(current_user)
        if current_user.is_authenticated
        else False
    )

    avg_rating = trip.get_avg_rating()
    likes_count = trip.get_likes_count()

    return render_template(
        "route_detail.html",
        trip=trip_obj,
        total_stops=total_stops,
        is_featured=trip.is_featured,
        reviews=reviews,
        is_liked=is_liked,
        is_favorited=is_favorited,
        trip_author=trip.author,
        avg_rating=avg_rating,
        likes_count=likes_count,
    )


@app.route("/api/delete_trip/<int:trip_id>", methods=["POST", "DELETE"])
@login_required
def delete_trip(trip_id):
    """Delete specified trip"""

    try:
        # Find trip
        trip = Trip.query.get_or_404(trip_id)

        # Permission check: Only trip owner can delete
        if trip.user_id != current_user.id:
            log_security_event(
                event_type="unauthorized_delete_attempt",
                description=f"User attempted to delete trip they do not own: {trip_id}",  # noqa: E501
                user=current_user,
                severity="warning",
            )
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "You do not have permission to delete this trip",  # noqa: E501
                    }
                ),
                403,
            )

        # Store trip info before deletion
        trip_name = trip.title or trip.name

        # Delete trip (will cascade delete all related TripStop)
        db.session.delete(trip)
        db.session.commit()

        # Log trip deletion
        log_activity(
            action_type="delete_trip",
            action_category="trip",
            description=f"Deleted trip: {trip_name}",
            user=current_user,
            details={"trip_id": trip_id, "trip_name": trip_name},
            status="success",
        )

        return (
            jsonify(
                {"status": "success", "message": "Trip deleted successfully"}
            ),
            200,
        )

    except Exception as e:
        db.session.rollback()
        log_activity(
            action_type="delete_trip_error",
            action_category="trip",
            description=f"Failed to delete trip: {str(e)}",
            user=current_user,
            details={"trip_id": trip_id, "error": str(e)},
            status="error",
        )
        print(f"Error deleting trip: {e}")
        return (
            jsonify({"status": "error", "message": "Failed to delete trip"}),
            500,
        )


@app.route("/api/my_trips")
@login_required
def get_my_trips():
    """Get all trips for current user - no database modification needed"""

    trips = (
        Trip.query.filter_by(user_id=current_user.id)
        .order_by(Trip.created_at.desc())
        .all()
    )

    trips_list = []
    for trip in trips:
        # Check if data field exists (new format)
        if hasattr(trip, "data") and trip.data:
            try:
                days_data = json.loads(trip.data)
                total_stops = sum(
                    len(day.get("stops", [])) for day in days_data
                )
                days_count = len(days_data)
            except Exception:
                days_data = []
                total_stops = 0
                days_count = 0
        else:
            # Fallback to stops relationship (old format)
            total_stops = len(trip.stops) if trip.stops else 0
            days_count = 1

        # Generate thumbnail URL (based on region)
        region_images = {
            "uk": "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=400&h=300&fit=crop",  # London  # noqa: E501
            "france": "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=400&h=300&fit=crop",  # Paris  # noqa: E501
            "italy": "https://images.unsplash.com/photo-1515542622106-78bda8ba0e5b?w=400&h=300&fit=crop",  # Rome  # noqa: E501
            "spain": "https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?w=400&h=300&fit=crop",  # Spain  # noqa: E501
            "usa": "https://images.unsplash.com/photo-1485738422979-f5c462d49f74?w=400&h=300&fit=crop",  # USA  # noqa: E501
            "japan": "https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=400&h=300&fit=crop",  # Japan  # noqa: E501
            "china": "https://images.unsplash.com/photo-1508804185872-d7badad00f7d?w=400&h=300&fit=crop",  # China  # noqa: E501
            "world": "https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=400&h=300&fit=crop",  # Travel  # noqa: E501
        }

        region = getattr(trip, "region", "world")
        thumbnail = region_images.get(region, region_images["world"])

        trips_list.append(
            {
                "id": trip.id,
                "name": getattr(trip, "name", None) or trip.title,
                "created_at": (
                    trip.created_at.strftime("%B %d, %Y")
                    if hasattr(trip.created_at, "strftime")
                    else (str(trip.created_at) if trip.created_at else None)
                ),
                "total_stops": total_stops,
                "days_count": days_count,
                "is_public": trip.is_public,
                "region": "",
                "thumbnail": thumbnail,  # Add thumbnail
            }
        )

    return jsonify({"trips": trips_list})


# =========================================
# 6.5. Featured routes related functionality
# =========================================


def load_featured_routes():
    """Load featured routes data from JSON file"""
    json_path = os.path.join(
        os.path.dirname(__file__), "featured_routes_data.json"
    )
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"âŒ Error: featured_routes_data.json not found at {json_path}")
        return {}
    except json.JSONDecodeError as e:
        print(f"âŒ Error: Invalid JSON in featured_routes_data.json: {e}")
        return {}


def init_featured_trips():
    """
    Initialize featured trips in database
    Only stores metadata - actual route data stays in JSON
    """
    # Check if already initialized
    existing = Trip.query.filter_by(is_featured=True).count()
    if existing > 0:
        print(f"Featured trips already initialized ({existing} found)")
        return

    # Get or create system user for featured trips
    system_user = User.query.filter_by(username='system').first()
    if not system_user:
        from werkzeug.security import generate_password_hash
        system_user = User(
            username='system',
            email='system@voyager.com',
            password_hash=generate_password_hash('VoyagerSystem2024!@#')
        )
        db.session.add(system_user)
        db.session.commit()
        print("âœ“ Created system user for featured trips")

    # Load featured routes from JSON
    featured_routes = load_featured_routes()
    if not featured_routes:
        print("âŒ No featured routes data found")
        return

    # Route ID mapping
    route_mapping = {
        'route_1_london': 'featured_1',
        'route_2_kyoto': 'featured_2',
        'route_3_paris': 'featured_3'
    }

    # Create Trip records (metadata only, full data stays in JSON)
    created_count = 0
    for route_key, route_data in featured_routes.items():
        if route_key not in route_mapping:
            continue

        trip = Trip(
            user_id=system_user.id,
            title=route_data['title'],
            name=route_data['title'],
            region=route_data['region'],
            is_featured=True,
            is_public=True,
            featured_key=route_key,
            total_stops=route_data['total_stops'],
            data=None  # Data stays in JSON
        )
        db.session.add(trip)
        created_count += 1
        print(f"  âœ“ Created featured trip: {route_data['title']}")

    db.session.commit()
    print(f"âœ“ Initialized {created_count} featured trips in database")


def calculate_distance(lat1, lon1, lat2, lon2):
    """Calculate distance between two points using Haversine formula (km)"""
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.asin(math.sqrt(a))
    return 6371 * c  # Earth radius (km)


def parse_duration(duration_str):
    """Parse duration string to hours"""
    try:
        duration_str = duration_str.lower()
        parts = duration_str.split()[0]
        if "-" in parts:
            nums = parts.split("-")
            avg = (float(nums[0]) + float(nums[1])) / 2
        else:
            avg = float(parts)

        if "hour" in duration_str:
            return avg
        else:  # minutes
            return avg / 60
    except Exception:
        return 1.0


def estimate_travel_time(distance_km, transport_mode="foot-walking"):
    """
    Estimate travel time (minutes)
    Use same logic as planner.js

    Args:
        distance_km: Distance (km)
        transport_mode: Transport mode ('foot-walking', 'cycling-regular', 'driving-car')  # noqa: E501

    Returns:
        int: Estimated time (minutes)
    """
    # Determine average speed based on transport mode
    if transport_mode == "cycling-regular":
        avg_speed = 15  # 15 km/h for cycling
        buffer_percent = 0.05  # 5% buffer
    elif transport_mode == "foot-walking":
        avg_speed = 5  # 5 km/h for walking
        buffer_percent = 0.05  # 5% buffer
    else:  # driving-car
        # Adjust speed based on distance
        if distance_km < 10:
            avg_speed = 40
        elif distance_km < 50:
            avg_speed = 60
        elif distance_km < 200:
            avg_speed = 80
        else:
            avg_speed = 90

        # Larger buffer for driving (considering traffic)
        buffer_percent = 0.2 if distance_km < 50 else 0.1

    # Calculate base time
    base_time = (distance_km / avg_speed) * 60  # Convert to minutes

    # Add buffer
    buffer_time = base_time * buffer_percent

    # Round up
    return math.ceil(base_time + buffer_time)


def convert_route_to_trip(route_data, route_id):
    """Convert route data to trip format for template"""

    transport_mode = route_data.get("transport_mode", "foot-walking")
    day_stops = []
    cumulative_travel_time = 0

    for idx, stop in enumerate(route_data["stops"], 1):
        hours_offset = sum(
            [
                parse_duration(s.get("visit_duration", "60 minutes"))
                for s in route_data["stops"][: idx - 1]
            ]
        )

        total_hours_offset = hours_offset + (cumulative_travel_time / 60)
        arrival_hour = 9 + int(total_hours_offset)
        arrival_min = int((total_hours_offset % 1) * 60)
        arrival_time = f"{arrival_hour:02d}:{arrival_min:02d}"
        duration_hours = parse_duration(
            stop.get("visit_duration", "60 minutes")
        )

        # Complete field mapping
        stop_obj = {
            "id": idx,
            "name": stop["name"],
            "fullName": f"{stop['name']}, {stop['city']}, {stop['country']}",
            "lat": stop["lat"],
            "lon": stop["lon"],
            "type": "attraction",
            "arrival": arrival_time,
            "duration": round(duration_hours, 1),

            # Original fields (keep for compatibility)
            "notes": stop.get("description", ""),
            "budget": None,
            "tips": stop.get("tips", []),
            "admission": stop.get("admission", ""),
            "transport": stop.get("transport", ""),

            # Fields required by HTML template
            "description": stop.get("description", ""),
            "address": f"{stop['city']}, {stop['country']}",
            "recommended_duration": stop.get("visit_duration", ""),
            "entry_fee": stop.get("admission", ""),
            "opening_hours": stop.get("opening_hours", ""),
            "insider_tips": (
                "\n".join([f"â€¢ {tip}" for tip in stop.get("tips", [])])
                if isinstance(stop.get("tips"), list) and stop.get("tips")
                else ""
            ),

            "routeFromPrevious": None,
        }

        if idx > 1:
            prev_stop = route_data["stops"][idx - 2]
            distance_km = calculate_distance(
                prev_stop["lat"], prev_stop["lon"], stop["lat"], stop["lon"]
            )
            duration_minutes = estimate_travel_time(
                distance_km, transport_mode
            )
            cumulative_travel_time += duration_minutes

            stop_obj["routeFromPrevious"] = {
                "distance": round(distance_km, 2),
                "duration": round(duration_minutes, 1),
                "provider": "Estimated",
            }

        day_stops.append(stop_obj)

    day = {"id": 1, "number": 1, "name": "Day 1", "stops": day_stops}

    trip = {
        "id": route_id,
        "name": route_data["title"],
        "region": route_data["region"],
        "description": route_data.get("description", ""),
        "best_time": route_data.get("best_time", ""),
        "estimated_duration": route_data.get("estimated_duration", ""),
        "is_public": True,
        "transport_mode": transport_mode,
        "days": [day],
        "author": None,
        "food_recommendations": route_data.get("food_recommendations", []),
    }

    return trip


@app.route("/fork_trip/<string:trip_id>", methods=["POST"])
@login_required
def fork_trip(trip_id):
    """Fork a trip (either featured or user trip) to current user's profile"""

    # Check if it's a featured route
    if trip_id.startswith("featured_"):
        # Load featured route data
        route_map = {
            "featured_1": "route_1_london",
            "featured_2": "route_2_kyoto",
            "featured_3": "route_3_paris",
        }

        if trip_id not in route_map:
            flash("Featured route not found", "error")
            return redirect(url_for("community"))

        route_key = route_map[trip_id]
        featured_routes_data = load_featured_routes()

        if not featured_routes_data or route_key not in featured_routes_data:
            flash("Failed to load route data", "error")
            return redirect(url_for("community"))

        route_data = featured_routes_data[route_key]

        # Create a new trip for the user based on featured route
        try:
            new_trip = Trip(
                user_id=current_user.id,
                title=f"{route_data['title']} (Forked)",
                name=route_data["title"],
                region=route_data.get("region", "world"),
                is_public=False,
                is_featured=False,
            )

            # Convert route data to trip format and save as JSON
            trip_dict = convert_route_to_trip(route_data, trip_id)
            new_trip.data = json.dumps(trip_dict["days"])

            # Add stops
            for idx, stop_data in enumerate(route_data.get("stops", []), 1):
                stop = TripStop(
                    destination_name=stop_data["name"],
                    lat=stop_data["lat"],
                    lon=stop_data["lon"],
                    order=idx,
                )
                new_trip.stops.append(stop)

            new_trip.total_stops = len(new_trip.stops)

            db.session.add(new_trip)
            db.session.commit()

            flash(
                f'Successfully forked "{route_data["title"]}" to your profile!',  # noqa: E501
                "success",
            )
            return redirect(url_for("route_detail", trip_id=new_trip.id))

        except Exception as e:
            db.session.rollback()
            print(f"Error forking featured route: {e}")
            flash("Failed to fork route. Please try again.", "error")
            return redirect(url_for("community"))

    else:
        # Fork a user trip
        try:
            trip_id_int = int(trip_id)
            original_trip = Trip.query.get_or_404(trip_id_int)

            # Prevent users from forking their own trips
            if original_trip.user_id == current_user.id:
                flash(
                    "You cannot fork your own trip. You can edit it directly from your profile.", "info")  # noqa: E501
                return redirect(url_for("route_detail", trip_id=trip_id))

            # Check if trip is public or user is owner
            if (
                not original_trip.is_public
                and original_trip.user_id != current_user.id
            ):
                flash("This trip is private", "error")
                return redirect(url_for("community"))

            # Create new trip
            new_trip = Trip(
                user_id=current_user.id,
                title=f"{original_trip.title} (Forked)",
                name=original_trip.name,
                region=original_trip.region,
                data=original_trip.data,
                is_public=False,
            )

            # Copy stops
            for stop in original_trip.stops:
                new_stop = TripStop(
                    destination_name=stop.destination_name,
                    lat=stop.lat,
                    lon=stop.lon,
                    order=stop.order,
                )
                new_trip.stops.append(new_stop)

            new_trip.total_stops = len(new_trip.stops)

            db.session.add(new_trip)
            db.session.commit()

            flash(
                f'Successfully forked "{original_trip.title}" to your profile!',  # noqa: E501
                "success",
            )
            return redirect(url_for("route_detail", trip_id=new_trip.id))

        except ValueError:
            flash("Invalid trip ID", "error")
            return redirect(url_for("community"))
        except Exception as e:
            db.session.rollback()
            print(f"Error forking trip: {e}")
            flash("Failed to fork trip. Please try again.", "error")
            return redirect(url_for("community"))


@app.route("/api/trip/<int:trip_id>/like", methods=["POST"])
@login_required
def like_trip(trip_id):
    """Toggle like status for a trip"""
    trip = Trip.query.get_or_404(trip_id)

    existing_like = TripLike.query.filter_by(
        user_id=current_user.id, trip_id=trip_id
    ).first()

    if existing_like:
        db.session.delete(existing_like)
        db.session.commit()
        return jsonify(
            {
                "status": "success",
                "liked": False,
                "likes_count": trip.get_likes_count(),
                "message": "Like removed",
            }
        )
    else:
        new_like = TripLike(user_id=current_user.id, trip_id=trip_id)
        db.session.add(new_like)
        db.session.commit()
        return jsonify(
            {
                "status": "success",
                "liked": True,
                "likes_count": trip.get_likes_count(),
                "message": "Trip liked",
            }
        )


@app.route("/api/trip/<int:trip_id>/favorite", methods=["POST"])
@login_required
def favorite_trip(trip_id):
    """Toggle favorite status for a trip"""
    trip = Trip.query.get_or_404(trip_id)

    if trip in current_user.favorite_trips:
        current_user.favorite_trips.remove(trip)
        db.session.commit()
        return jsonify(
            {
                "status": "success",
                "favorited": False,
                "message": "Removed from favorites",
            }
        )
    else:
        current_user.favorite_trips.append(trip)
        db.session.commit()
        return jsonify(
            {
                "status": "success",
                "favorited": True,
                "message": "Added to favorites",
            }
        )


@app.route("/submit_trip_review/<string:trip_id>", methods=["POST"])
@login_required
def submit_trip_review(trip_id):
    """
    Submit or update a review for a trip

    Args:
        trip_id (string): Trip ID (featured route or regular trip ID)

    Returns:
        Redirect to route detail page
    """

    # Check if this is a featured route (cannot be reviewed)
    if isinstance(trip_id, str) and trip_id.startswith("featured_"):
        flash(
            "Featured routes cannot be reviewed. Please fork the route "
            "first to leave a review.",
            "info"
        )
        return redirect(url_for("route_detail", trip_id=trip_id))

    # Convert trip_id to integer for database trips
    try:
        trip_id = int(trip_id)
    except ValueError:
        app.logger.error(f"[TripReview] Invalid trip_id: {trip_id}")
        flash("Invalid trip ID", "error")
        return redirect(url_for("community"))

    try:
        # Verify trip exists
        trip = Trip.query.get_or_404(trip_id)

        # Get form data
        rating = request.form.get("rating", type=int)
        comment = request.form.get("comment", "").strip()

        # Detailed logging for debugging
        app.logger.info(
            f"[TripReview] User {current_user.id} submitting review "
            f"for trip {trip_id}"
        )
        app.logger.info(
            f"[TripReview] Rating: {rating}, Comment length: "
            f"{len(comment) if comment else 0}"
        )

        # Validate rating exists
        if not rating:
            app.logger.warning(
                f"[TripReview] Missing rating from user "
                f"{current_user.id}"
            )
            flash("Please select a rating (1-5 stars)", "error")
            return redirect(url_for("route_detail", trip_id=trip_id))

        # Validate rating range (1-5 stars)
        if rating < 1 or rating > 5:
            app.logger.warning(
                f"[TripReview] Invalid rating {rating} from user "
                f"{current_user.id}"
            )
            flash("Rating must be between 1 and 5 stars", "error")
            return redirect(url_for("route_detail", trip_id=trip_id))

        # Validate comment length (max 500 characters)
        if comment and len(comment) > 500:
            flash("Comment is too long (maximum 500 characters)", "error")
            return redirect(url_for("route_detail", trip_id=trip_id))

        # Check if user already has a review for this trip
        existing_review = TripReview.query.filter_by(
            user_id=current_user.id,
            trip_id=trip_id
        ).first()

        if existing_review:
            # Update existing review
            app.logger.info(
                f"[TripReview] Updating existing review "
                f"{existing_review.id}"
            )
            existing_review.rating = rating
            existing_review.comment = comment
            existing_review.updated_at = datetime.utcnow()

            flash_message = "Your review has been updated successfully!"
            log_action = "update_trip_review"
        else:
            # Create new review
            app.logger.info("[TripReview] Creating new review")
            new_review = TripReview(
                user_id=current_user.id,
                trip_id=trip_id,
                rating=rating,
                comment=comment
            )
            db.session.add(new_review)

            flash_message = "Thank you for your review!"
            log_action = "create_trip_review"

        # Commit to database
        try:
            db.session.commit()
            app.logger.info(
                "[TripReview] Successfully saved review to database"
            )

            # Log activity for audit trail
            log_activity(
                action_type=log_action,
                action_category="trip_review",
                description=f"Review for trip: {trip.title}",
                user=current_user,
                details={
                    "trip_id": trip_id,
                    "rating": rating,
                    "has_comment": bool(comment)
                },
                status="success"
            )

            flash(flash_message, "success")

        except Exception as commit_error:
            # Rollback on commit failure
            db.session.rollback()
            app.logger.error(
                f"[TripReview] Database commit failed: "
                f"{str(commit_error)}"
            )
            app.logger.error(
                f"[TripReview] Error type: "
                f"{type(commit_error).__name__}"
            )

            # Log full traceback for debugging
            import traceback
            app.logger.error(
                f"[TripReview] Traceback: {traceback.format_exc()}"
            )

            flash("Failed to save your review. Please try again.", "error")

    except Exception as e:
        # Handle unexpected errors
        db.session.rollback()
        app.logger.error(f"[TripReview] Unexpected error: {str(e)}")

        # Log full traceback
        import traceback
        app.logger.error(f"[TripReview] Traceback: {traceback.format_exc()}")

        flash("An unexpected error occurred. Please try again.", "error")

    # Always redirect back to route detail page
    return redirect(url_for("route_detail", trip_id=trip_id))


@app.route("/api/trip_review/<int:review_id>", methods=["PUT", "DELETE"])
@login_required
def manage_trip_review(review_id):
    """Update or delete a trip review"""
    review = TripReview.query.get_or_404(review_id)

    if review.user_id != current_user.id:
        return jsonify({"status": "error", "message": "Unauthorized"}), 403

    if request.method == "DELETE":
        db.session.delete(review)
        db.session.commit()
        return jsonify({"status": "success", "message": "Review deleted"})

    elif request.method == "PUT":
        data = request.get_json()
        rating = data.get("rating", type=int)
        comment = data.get("comment", "").strip()

        if not rating or rating < 1 or rating > 5:
            return (
                jsonify({"status": "error", "message": "Invalid rating"}),
                400,
            )

        if len(comment) > 500:
            return (
                jsonify({"status": "error", "message": "Comment too long"}),
                400,
            )

        review.rating = rating
        review.comment = comment
        review.updated_at = datetime.utcnow()
        db.session.commit()

        return jsonify(
            {
                "status": "success",
                "message": "Review updated",
                "review": {
                    "id": review.id,
                    "rating": review.rating,
                    "comment": review.comment,
                    "updated_at": review.updated_at.strftime("%B %d, %Y"),
                },
            }
        )


@app.route("/profile/change-password", methods=["POST"])
@login_required
def change_password():
    """Handle password change from profile page"""
    try:
        current_password = request.form.get("current_password", "").strip()
        new_password = request.form.get("new_password", "").strip()
        confirm_new_password = request.form.get(
            "confirm_new_password", ""
        ).strip()

        # Get the current user from database
        user = db.session.query(User).get(current_user.id)

        # Validate current password
        if not user.check_password(current_password):
            flash("Current password is incorrect", "error")
            return redirect(url_for("profile"))

        # Validate new password
        is_valid_password, password_error = validate_password(new_password)
        if not is_valid_password:
            flash(password_error, "error")
            return redirect(url_for("profile"))

        # Check if passwords match
        if new_password != confirm_new_password:
            flash("New passwords do not match", "error")
            return redirect(url_for("profile"))

        # Check if new password is different from current
        if current_password == new_password:
            flash(
                "New password must be different from current password", "error"
            )
            return redirect(url_for("profile"))

        # Update password
        user.set_password(new_password)
        db.session.commit()

        flash("Password updated successfully!", "success")
        return redirect(url_for("profile"))

    except Exception as e:
        db.session.rollback()
        app.logger.error(f"Error changing password: {str(e)}")
        flash(
            "An error occurred while changing password. Please try again.",
            "error",
        )
        return redirect(url_for("profile"))


# =========================================
# made public/Privacy status API
# =========================================


@app.route("/api/toggle_trip_public/<int:trip_id>", methods=["POST"])
@login_required
def toggle_trip_public(trip_id):
    """
    Toggle trip public/private status
    Only trip owner can toggle
    """
    try:
        trip = Trip.query.get_or_404(trip_id)

        # Permission check: only owner can toggle
        if trip.user_id != current_user.id:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "You do not have permission to modify this trip",  # noqa: E501
                    }
                ),
                403,
            )

        # Featured routes cannot be made private
        if trip.is_featured:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "Featured routes cannot be made private",
                    }
                ),
                400,
            )

        # Toggle the status
        trip.is_public = not trip.is_public
        db.session.commit()

        return (
            jsonify(
                {
                    "status": "success",
                    "is_public": trip.is_public,
                    "message": f'Trip is now {"public" if trip.is_public else "private"}',  # noqa: E501
                }
            ),
            200,
        )

    except Exception as e:
        db.session.rollback()
        print(f"Error toggling trip public status: {e}")
        return (
            jsonify(
                {"status": "error", "message": "Failed to update trip status"}
            ),
            500,
        )


# =========================================
# Delete destination comment
# =========================================


@app.route("/api/review/<int:review_id>/delete", methods=["POST"])
@login_required
def delete_destination_review(review_id):
    """
    Delete destination comment

    Permission check:
    1. Comment author can delete
    2. Admin can delete any comment
    """
    try:
        review = Review.query.get_or_404(review_id)
        destination_id = review.destination_id

        # Permission check
        can_delete = False
        reason = ""

        # case1: Comment author
        if review.user_id == current_user.id:
            can_delete = True
            reason = "author"

        # case2: Administrator
        elif hasattr(current_user, "is_admin") and current_user.is_admin:
            can_delete = True
            reason = "admin"

        if not can_delete:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "You do not have permission to delete "
                        "this comment",
                    }
                ),
                403,
            )

        # Log record (If admin operation)
        if reason == "admin":
            log_admin_action(
                "delete_destination_review",
                "review",
                review_id,
                {
                    "destination_id": destination_id,
                    "user_id": review.user_id,
                    "rating": review.rating,
                },
            )

        # Delete comment
        db.session.delete(review)
        db.session.commit()

        return jsonify(
            {
                "status": "success",
                "message": "Comment deleted",
                "deleted_by": reason,
            }
        )

    except Exception as e:
        db.session.rollback()
        return (
            jsonify(
                {"status": "error", "message": f"Delete failed: {str(e)}"}
            ),
            500,
        )


# =========================================
# Delete tripComment
# =========================================


@app.route("/api/trip_review/<int:review_id>/delete", methods=["POST"])
@login_required
def delete_trip_review(review_id):
    """
    Delete trip comment

    Permission check:
    1. Comment author can delete
    2. Trip author can delete comments under their own trip
    3. Admin can delete any comment
    """
    try:
        review = TripReview.query.get_or_404(review_id)
        trip = Trip.query.get_or_404(review.trip_id)

        # Permission check
        can_delete = False
        reason = ""

        # case1: Comment author
        if review.user_id == current_user.id:
            can_delete = True
            reason = "review_author"

        # case2: Trip author (Can delete comments under own trip)
        elif trip.user_id == current_user.id:
            can_delete = True
            reason = "trip_author"

        # case3: Administrator
        elif hasattr(current_user, "is_admin") and current_user.is_admin:
            can_delete = True
            reason = "admin"

        if not can_delete:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": "You do not have permission to delete "
                        "this comment",
                    }
                ),
                403,
            )

        # Log record (If admin or trip author deleting others' comments)
        if reason in ["admin", "trip_author"]:
            log_admin_action(
                "delete_trip_review",
                "trip_review",
                review_id,
                {
                    "trip_id": review.trip_id,
                    "review_user_id": review.user_id,
                    "deleted_by": reason,
                    "rating": review.rating,
                },
            )

        # Delete comment
        db.session.delete(review)
        db.session.commit()

        return jsonify(
            {
                "status": "success",
                "message": "Comment deleted",
                "deleted_by": reason,
            }
        )

    except Exception as e:
        db.session.rollback()
        return (
            jsonify({"status": "error", "message": f"Delete failed: {str(e)}"}),
            500,
        )


# =========================================
# Check comment permissionsï¼ˆHelperAPIï¼‰
# =========================================


@app.route("/api/review/<int:review_id>/permissions", methods=["GET"])
@login_required
def check_review_permissions(review_id):
    """
    Check current user's permissions for a comment
    return: can_edit, can_delete, reason
    """
    try:
        review = Review.query.get_or_404(review_id)

        permissions = {"can_edit": False, "can_delete": False, "reason": None}

        # Comment author
        if review.user_id == current_user.id:
            permissions["can_edit"] = True
            permissions["can_delete"] = True
            permissions["reason"] = "author"

        # Administrator
        elif hasattr(current_user, "is_admin") and current_user.is_admin:
            permissions["can_delete"] = True
            permissions["reason"] = "admin"

        return jsonify({"status": "success", "permissions": permissions})

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/trip_review/<int:review_id>/permissions", methods=["GET"])
@login_required
def check_trip_review_permissions(review_id):
    """
    Check current user's permissions for a trip comment
    è¿”å›ž: can_edit, can_delete, reason
    """
    try:
        review = TripReview.query.get_or_404(review_id)
        trip = Trip.query.get_or_404(review.trip_id)

        permissions = {"can_edit": False, "can_delete": False, "reason": None}

        # Comment author
        if review.user_id == current_user.id:
            permissions["can_edit"] = True
            permissions["can_delete"] = True
            permissions["reason"] = "review_author"

        # Trip author
        elif trip.user_id == current_user.id:
            permissions["can_delete"] = True
            permissions["reason"] = "trip_author"

        # Administrator
        elif hasattr(current_user, "is_admin") and current_user.is_admin:
            permissions["can_delete"] = True
            permissions["reason"] = "admin"

        return jsonify({"status": "success", "permissions": permissions})

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# =========================================
# ADMIN FUNCTIONALITY
# =========================================

# Admin required decorator


def admin_required(f):
    """Administrator permission decorator with automatic logging"""

    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated:
            log_security_event(
                event_type="admin_access_denied",
                description=f"Unauthenticated access attempt to admin route: {request.endpoint}",  # noqa: E501
                severity="warning",
            )
            flash("Please login first", "error")
            return redirect(url_for("login"))
        if not getattr(current_user, "is_admin", False):
            log_security_event(
                event_type="admin_access_denied",
                description=f"Non-admin user attempted to access: {request.endpoint}",  # noqa: E501
                user=current_user,
                severity="warning",
            )
            flash("You do not have permission to access this page", "error")
            abort(403)

        log_activity(
            action_type="admin_access",
            action_category="admin",
            description=f"Admin accessed: {request.endpoint}",
            user=current_user,
            status="success",
        )
        return f(*args, **kwargs)

    return decorated_function


def log_admin_action(
    action_type, target_type=None, target_id=None, details=None
):
    """Log administrator operation to admin_log table"""
    try:
        # Get current user
        admin_user = current_user if current_user.is_authenticated else None
        
        if not admin_user or not admin_user.is_admin:
            # If not admin, log to activity_log instead
            log_activity(
                action_type=action_type,
                action_category="admin_attempt",
                description=f"Non-admin attempted admin action: {action_type}",
                user=admin_user,
                details={
                    "target_type": target_type,
                    "target_id": target_id,
                    **(details if details else {}),
                },
                status="failed",
            )
            return
        
        # Get IP address
        ip_address = request.remote_addr if request else "system"
        
        # Create admin log entry
        admin_log = AdminLog(
            admin_id=admin_user.id,
            action_type=action_type,
            target_type=target_type,
            target_id=target_id,
            details=json.dumps(details) if details else None,
            ip_address=ip_address
        )
        
        db.session.add(admin_log)
        db.session.commit()
        
        # Also log to activity_log for unified tracking
        log_activity(
            action_type=action_type,
            action_category="admin",
            description=f"Admin action: {action_type}",
            user=admin_user,
            details={
                "target_type": target_type,
                "target_id": target_id,
                **(details if details else {}),
            },
            status="success",
        )
        
    except Exception as e:
        app.logger.error(f"Failed to log admin action: {e}")
        db.session.rollback()


# ===== Administrator dashboard =====


@app.route("/admin")
@admin_required
def admin_dashboard():
    """Administrator dashboard"""
    stats = {
        "total_trips": Trip.query.count(),
        "total_destinations": Destination.query.count(),
        "total_reviews": Review.query.count(),
        "total_trip_reviews": TripReview.query.count(),
        "new_trips_today": 0,
        "recent_admin_actions": [],
    }

    today = datetime.utcnow().date()

    stats["new_trips_today"] = Trip.query.filter(
        db.func.date(Trip.created_at) == today
    ).count()

    try:
        stats["recent_admin_actions"] = (
            AdminLog.query.order_by(AdminLog.created_at.desc()).limit(10).all()
        )
    except Exception:
        stats["recent_admin_actions"] = []

    trip_chart_data = {"dates": [], "new_trips": []}

    for i in range(30, -1, -1):
        date = (datetime.utcnow() - timedelta(days=i)).date()
        date_str = date.strftime("%m/%d")

        trip_chart_data["dates"].append(date_str)

        trip_count = Trip.query.filter(
            db.func.date(Trip.created_at) == date
        ).count()
        trip_chart_data["new_trips"].append(trip_count)

    return render_template(
        "admin_dashboard.html",
        stats=stats,
        trip_chart_data=trip_chart_data,
    )


# ===== Trip Management =====


@app.route("/admin_trips")
@admin_required
def admin_trips():
    """Trip management page"""
    page = request.args.get("page", 1, type=int)
    query = request.args.get("q", "")
    status = request.args.get("status", "all")

    trips_query = Trip.query

    if query:
        trips_query = trips_query.filter(
            db.or_(Trip.title.contains(query), Trip.name.contains(query))
        )

    if status == "public":
        trips_query = trips_query.filter_by(is_public=True)
    elif status == "private":
        trips_query = trips_query.filter_by(is_public=False)
    elif status == "featured":
        trips_query = trips_query.filter_by(is_featured=True)

    trips_query = trips_query.order_by(Trip.created_at.desc())
    pagination = trips_query.paginate(page=page, per_page=20, error_out=False)

    return render_template(
        "admin_trips.html",
        trips=pagination.items,
        pagination=pagination,
        query=query,
        status=status,
    )


@app.route("/admin_trips/<int:trip_id>/toggle-public", methods=["POST"])
@admin_required
def admin_toggle_trip_public(trip_id):
    """Toggle trip public status"""
    trip = Trip.query.get_or_404(trip_id)

    trip.is_public = not trip.is_public
    db.session.commit()

    log_admin_action(
        "toggle_public",
        "trip",
        trip_id,
        {"title": trip.title, "is_public": trip.is_public},
    )

    return jsonify(
        {
            "status": "success",
            "message": f'Trip has been {"made public" if trip.is_public else "set to private"}',  # noqa: E501
            "is_public": trip.is_public,
        }
    )


@app.route("/admin_trips/<int:trip_id>/toggle-featured", methods=["POST"])
@admin_required
def admin_toggle_trip_featured(trip_id):
    """Toggle trip featured status"""
    trip = Trip.query.get_or_404(trip_id)

    trip.is_featured = not trip.is_featured
    if trip.is_featured:
        trip.is_public = True

    db.session.commit()

    log_admin_action(
        "toggle_featured",
        "trip",
        trip_id,
        {"title": trip.title, "is_featured": trip.is_featured},
    )

    return jsonify(
        {
            "status": "success",
            "message": f'Trip has been {"set as featured" if trip.is_featured else "unfeatured"}',  # noqa: E501
            "is_featured": trip.is_featured,
        }
    )


@app.route("/admin_trips/<int:trip_id>/delete", methods=["POST"])
@admin_required
def admin_delete_trip(trip_id):
    """Delete trip"""
    trip = Trip.query.get_or_404(trip_id)

    title = trip.title or trip.name

    log_admin_action(
        "delete_trip",
        "trip",
        trip_id,
        {"title": title, "author": trip.author.username},
    )

    db.session.delete(trip)
    db.session.commit()

    return jsonify(
        {"status": "success", "message": f'Trip "{title}" has been deleted'}
    )


@app.route("/admin_trips/bulk-action", methods=["POST"])
@admin_required
def admin_trips_bulk_action():
    """Bulk action on trips"""
    data = request.get_json()
    action = data.get("action")
    trip_ids = data.get("trip_ids", [])

    if not trip_ids:
        return (
            jsonify(
                {
                    "status": "error",
                    "message": "Please select at least one trip",
                }
            ),
            400,
        )

    try:
        trips = Trip.query.filter(Trip.id.in_(trip_ids)).all()

        if action == "make_public":
            for trip in trips:
                trip.is_public = True
            message = f"å·²made public {len(trips)} trips"
        elif action == "make_private":
            for trip in trips:
                trip.is_public = False
                trip.is_featured = False
            message = f"å·²set to private {len(trips)} trips"
        elif action == "delete":
            for trip in trips:
                db.session.delete(trip)
            message = f"Deleted {len(trips)} trips"
        else:
            return (
                jsonify({"status": "error", "message": "Invalid operation"}),
                400,
            )

        db.session.commit()

        log_admin_action(
            f"bulk_{action}",
            "trip",
            None,
            {"count": len(trips), "trip_ids": trip_ids},
        )

        return jsonify({"status": "success", "message": message})

    except Exception as e:
        db.session.rollback()
        return (
            jsonify(
                {"status": "error", "message": f"Operation failed: {str(e)}"}
            ),
            500,
        )


# ===== Placeholder Routes =====


# ===== Destination Management =====

@app.route("/admin_destinations")
@admin_required
def admin_destinations():
    """Destination management page"""
    page = request.args.get("page", 1, type=int)
    query = request.args.get("q", "")
    category = request.args.get("category", "all")

    dest_query = Destination.query

    if query:
        dest_query = dest_query.filter(
            db.or_(
                Destination.name.contains(query),
                Destination.city.contains(query)
            )
        )

    if category != "all":
        dest_query = dest_query.filter_by(category=category)

    pagination = dest_query.paginate(page=page, per_page=15, error_out=False)
    
    # Get all unique categories for filter
    categories = db.session.query(Destination.category).distinct().all()
    categories = [c[0] for c in categories if c[0]]

    return render_template(
        "admin_destinations.html",
        destinations=pagination.items,
        pagination=pagination,
        query=query,
        current_category=category,
        categories=categories
    )

@app.route("/admin_destinations/new", methods=["GET", "POST"])
@admin_required
def admin_add_destination():
    """Add a new destination"""
    if request.method == "POST":
        try:
            new_dest = Destination(
                name=request.form.get("name"),
                city=request.form.get("city"),
                category=request.form.get("category"),
                desc=request.form.get("desc"),
                lat=float(request.form.get("lat", 0)),
                lon=float(request.form.get("lon", 0)),
                image=request.form.get("image"), # In real app, handle file upload here
                opening_hours=request.form.get("opening_hours"),
                visit_duration=request.form.get("visit_duration")
            )
            db.session.add(new_dest)
            db.session.commit()
            
            log_admin_action("create_destination", "destination", new_dest.id, {"name": new_dest.name})
            flash("Destination added successfully", "success")
            return redirect(url_for("admin_destinations"))
        except Exception as e:
            db.session.rollback()
            flash(f"Error adding destination: {str(e)}", "error")

    return render_template("admin_destination_form.html")

@app.route("/admin_destinations/<int:dest_id>/delete", methods=["POST"])
@admin_required
def admin_delete_destination(dest_id):
    """Delete a destination"""
    dest = Destination.query.get_or_404(dest_id)
    name = dest.name
    
    try:
        db.session.delete(dest)
        db.session.commit()
        log_admin_action("delete_destination", "destination", dest_id, {"name": name})
        return jsonify({"status": "success", "message": "Destination deleted"})
    except Exception as e:
        db.session.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/admin_reviews")
@admin_required
def admin_reviews():
    """Review management page (Destinations)"""
    page = request.args.get("page", 1, type=int)
    query = request.args.get("q", "")
    
    # Join with User and Destination to search by username or place name
    review_query = Review.query.join(User).join(Destination)

    if query:
        review_query = review_query.filter(
            db.or_(
                Review.comment.contains(query),
                User.username.contains(query),
                Destination.name.contains(query)
            )
        )

    review_query = review_query.order_by(Review.created_at.desc())
    pagination = review_query.paginate(page=page, per_page=20, error_out=False)

    return render_template(
        "admin_reviews.html",
        reviews=pagination.items,
        pagination=pagination,
        query=query
    )


@app.route("/admin_reviews/<int:review_id>/delete", methods=["POST"])
@admin_required
def admin_delete_review(review_id):
    """Admin delete review endpoint"""
    review = Review.query.get_or_404(review_id)
    try:
        db.session.delete(review)
        db.session.commit()
        log_admin_action("delete_review", "review", review_id)
        return jsonify({"status": "success", "message": "Review deleted"})
    except Exception as e:
        db.session.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/admin_logs")
@admin_required
def admin_logs():
    """Activity Logs page"""
    page = request.args.get("page", 1, type=int)
    log_type = request.args.get("type", "all")
    
    if log_type == "admin":
        query = AdminLog.query.order_by(AdminLog.created_at.desc())
    else:
        query = ActivityLog.query.order_by(ActivityLog.created_at.desc())
        
    pagination = query.paginate(page=page, per_page=30, error_out=False)
    
    return render_template(
        "admin_logs.html",
        logs=pagination.items,
        pagination=pagination,
        log_type=log_type
    )


@app.route("/admin/settings")
@admin_required
def admin_settings():
    flash("System settings feature under development...", "info")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/destinations/new")
@admin_required
def admin_new_destination():
    flash("Destination editing feature under development...", "info")
    return redirect(url_for("admin_dashboard"))


if __name__ == "__main__":
    with app.app_context():
        db.create_all()
        init_db()
    app.run(debug=True)