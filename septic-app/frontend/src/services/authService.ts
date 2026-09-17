import axios from 'axios';

const API_BASE = '/api';

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface User {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  role: 'admin' | 'manager' | 'driver' | 'office';
  created_at: string;
  updated_at: string;
}

export type UserRole = User['role'];

export interface AuthResponse {
  token: string;
  user: User;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  loading: boolean;
}

class AuthService {
  private tokenKey = 'jwt_token';
  private userKey = 'jwt_user';

  // Initialize axios with auth interceptors
  private setupInterceptors() {
    axios.interceptors.request.use(
      (config) => {
        const token = this.getToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          this.logout();
          window.location.href = '/login?expired=true';
        }
        return Promise.reject(error);
      }
    );
  }

  // Login
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    try {
      const response = await axios.post<AuthResponse>(
        `${API_BASE}/auth/login`,
        credentials
      );

      if (response.data.token) {
        this.setToken(response.data.token);
        this.setUser(response.data.user);
        this.setupInterceptors();
      }

      return response.data;
    } catch (error: any) {
      throw error.response?.data?.error || 'Login failed';
    }
  }

  // Get current user
  async getCurrentUser(): Promise<User> {
    try {
      const response = await axios.get<User>(`${API_BASE}/auth/me`);
      return response.data;
    } catch (error: any) {
      throw error.response?.data?.error || 'Failed to get user profile';
    }
  }

  // Logout
  logout(): void {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
    // Clear axios interceptors by resetting the instance
    axios.defaults.headers.common['Authorization'] = '';
  }

  // Token management
  setToken(token: string): void {
    localStorage.setItem(this.tokenKey, token);
  }

  getToken(): string | null {
    return localStorage.getItem(this.tokenKey);
  }

  // User management
  setUser(user: User): void {
    localStorage.setItem(this.userKey, JSON.stringify(user));
  }

  getUser(): User | null {
    const userStr = localStorage.getItem(this.userKey);
    return userStr ? JSON.parse(userStr) : null;
  }

  // Check if user has required role
  hasRole(allowedRoles: string[]): boolean {
    const user = this.getUser();
    if (!user) return false;
    return allowedRoles.includes(user.role);
  }

  // Check authentication status
  isAuthenticated(): boolean {
    const token = this.getToken();
    const user = this.getUser();
    return !!token && !!user;
  }

  // Initialize auth on app start
  initialize(): AuthState {
    const token = this.getToken();
    const user = this.getUser();

    if (token && user) {
      this.setupInterceptors();
      return {
        isAuthenticated: true,
        user,
        token,
        loading: false
      };
    }

    return {
      isAuthenticated: false,
      user: null,
      token: null,
      loading: false
    };
  }
}

export const authService = new AuthService();
export default authService;
