import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { authService, User, UserRole } from '../services/authService';

interface ProtectedRouteProps {
  children: React.ReactNode;
  // UserRole, not string[]. With string[] a stale or misspelled role compiles fine and
  // silently matches nobody, so the route quietly redirects everyone to /login --
  // which is exactly what happened when 'technician' was replaced by 'driver'.
  // Typing it turns that class of bug into a compile error.
  requiredRoles?: UserRole[];
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ 
  children, 
  requiredRoles 
}) => {
  const [isChecking, setIsChecking] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const location = useLocation();

  useEffect(() => {
    // Check authentication on mount
    const authState = authService.initialize();
    
    if (authState.isAuthenticated) {
      setUser(authState.user);
      
      // Check role-based access if required
      const role = authState.user?.role;
      if (requiredRoles && (!role || !requiredRoles.includes(role))) {
        // User doesn't have required role
        setUser(null);
      }
    }
    
    setIsChecking(false);
  }, [requiredRoles]);

  if (isChecking) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh'
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    // Redirect to login with return location
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

// Pre-configured protected route components for common roles.
//
// Currently unwired: every screen behind AuthenticatedRoute is readable by every role,
// because the server has no role checks either and a gate on one side of a request is
// theatre. They are kept rather than deleted because they are the mechanism Stage 6
// needs, they cost nothing at runtime, and unlike the entities they describe nothing
// that could be quietly wrong.

export const AdminRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ProtectedRoute requiredRoles={['admin']}>{children}</ProtectedRoute>
);

export const ManagerRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ProtectedRoute requiredRoles={['admin', 'manager']}>{children}</ProtectedRoute>
);

export const DriverRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ProtectedRoute requiredRoles={['admin', 'manager', 'driver']}>{children}</ProtectedRoute>
);

export const OfficeRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ProtectedRoute requiredRoles={['admin', 'manager', 'office']}>{children}</ProtectedRoute>
);

export const AuthenticatedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ProtectedRoute>{children}</ProtectedRoute>
);

export default ProtectedRoute;
