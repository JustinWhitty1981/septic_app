import React, { useState, useEffect } from 'react';
import {
  Box,
  Container,
  Paper,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  InputAdornment,
  IconButton
} from '@mui/material';
import {
  Visibility,
  VisibilityOff,
  LockOutlined,
  Login as LoginIcon
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { authService, LoginCredentials } from '../services/authService';
import { homeFor } from '../nav';
import { DEFAULT_COMPANY_NAME } from './Letterhead';

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [credentials, setCredentials] = useState<LoginCredentials>({
    email: '',
    password: ''
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check if already logged in
    if (authService.isAuthenticated()) {
      // Back to wherever the user was reaching for, else their own home — and the home
      // is by role, not one hardcoded path. A default at the front door is the one place
      // a wrong path is guaranteed to be hit on every single login, and a driver sent to
      // the office due queue sees 7,266 sites they cannot act on and no way to find the
      // few they were sent to.
      const from = (location.state as any)?.from?.pathname || homeFor(authService.getUser()?.role);
      navigate(from, { replace: true });
    }

    // Check for expired token message
    const params = new URLSearchParams(location.search);
    if (params.get('expired') === 'true') {
      setError('Your session has expired. Please log in again.');
    }
  }, [navigate, location]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCredentials(prev => ({ ...prev, [name]: value }));
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { user } = await authService.login(credentials);

      // The page they were reaching for, else the home for the role the server just
      // confirmed. Read the role off the response, not localStorage: this is the one
      // moment it is guaranteed fresh, and the point is not to land a driver on the
      // office board because a cached profile still called them office.
      const from = (location.state as any)?.from?.pathname || homeFor(user?.role);
      navigate(from, { replace: true });
    } catch (err: any) {
      setError(typeof err === 'string' ? err : 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword);
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default'
      }}
    >
      <Container maxWidth="sm">
        <Paper elevation={3} sx={{ p: 4 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <Box
              sx={{
                bgcolor: 'primary.main',
                borderRadius: '50%',
                p: 1,
                mb: 2
              }}
            >
              <LockOutlined sx={{ fontSize: 40, color: 'white' }} />
            </Box>
            
            <Typography variant="h4" component="h1" gutterBottom align="center">
              {DEFAULT_COMPANY_NAME}
            </Typography>
            
            <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
              Sign in to manage compliance records
            </Typography>

            {error && (
              <Alert severity="error" sx={{ width: '100%', mb: 2 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            <Box component="form" onSubmit={handleSubmit} sx={{ width: '100%' }}>
              <TextField
                margin="normal"
                required
                fullWidth
                id="email"
                label="Email Address"
                name="email"
                autoComplete="email"
                autoFocus
                value={credentials.email}
                onChange={handleChange}
                error={!!error}
              />
              
              <TextField
                margin="normal"
                required
                fullWidth
                name="password"
                label="Password"
                type={showPassword ? 'text' : 'password'}
                id="password"
                autoComplete="current-password"
                value={credentials.password}
                onChange={handleChange}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="toggle password visibility"
                        onClick={togglePasswordVisibility}
                        edge="end"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  )
                }}
                error={!!error}
              />
              
              <Button
                type="submit"
                fullWidth
                variant="contained"
                size="large"
                sx={{ mt: 3, mb: 2 }}
                disabled={loading}
                startIcon={loading ? <CircularProgress size={20} /> : <LoginIcon />}
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </Button>

              <Typography variant="caption" color="text.secondary" display="block"
                align="center" sx={{ mt: 1 }}>
                Forgot your password? An admin resets it on the Accounts screen —
                there are no shared or default credentials in this system.
              </Typography>
            </Box>
          </Box>
        </Paper>
        
        <Typography variant="caption" color="text.secondary" align="center" sx={{ mt: 2 }}>
          Septic Service Management System
        </Typography>
      </Container>
    </Box>
  );
};

export default LoginPage;
