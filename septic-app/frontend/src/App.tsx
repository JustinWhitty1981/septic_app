import React, { useState } from 'react';
import {
  BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation, useNavigate,
} from 'react-router-dom';
import {
  Box, AppBar, Toolbar, Typography, IconButton, Drawer, List, ListItemButton,
  ListItemIcon, ListItemText, Divider, Container, CssBaseline, Chip, Avatar, Button,
} from '@mui/material';
import {
  Menu as MenuIcon, Pool as DueQueueIcon, Search as SearchIcon,
  ExitToApp as LogoutIcon, LockOutlined, Report as QuarantineIcon,
  Route as RoutesIcon, LocalShipping as DispatchIcon,
  Assessment as LedgerIcon, ReceiptLong as InvoicesIcon, ManageAccounts as UsersIcon,
  RequestQuote as ReceivablesIcon, Warehouse as DisposalIcon,
  PendingActions as BillingQueueIcon,
  RequestPage as BidsIcon, Sell as PriceListIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { authService, User } from './services/authService';
import { homeFor, OFFICE_ROLES as OFFICE } from './nav';
import LoginPage from './components/LoginPage';
import { AuthenticatedRoute } from './components/ProtectedRoute';
import DueQueuePage from './components/DueQueuePage';
import UnbilledWorkPage from './components/UnbilledWorkPage';
import SiteSearchPage from './components/SiteSearchPage';
import PropertyDetailPage from './components/PropertyDetailPage';
import QuarantinePage from './components/QuarantinePage';
import RouteComposerPage from './components/RouteComposerPage';
import DispatchPage from './components/DispatchPage';
import LedgerReportPage from './components/LedgerReportPage';
import InvoicesPage from './components/InvoicesPage';
import UsersPage from './components/UsersPage';
import ReceivablesPage from './components/ReceivablesPage';
import PrintInvoicePage from './components/PrintInvoicePage';
import DisposalSitesPage from './components/DisposalSitesPage';
import BidsPage from './components/BidsPage';
import BidDetailPage from './components/BidDetailPage';
import BidPrintPage from './components/BidPrintPage';
import PriceListPage from './components/PriceListPage';
import SettingsPage from './components/SettingsPage';
import { DEFAULT_COMPANY_NAME } from './components/Letterhead';

/**
 * Six screens. Two audiences.
 *
 * This file used to route to seven components across /compliance, /customers and
 * /inventory, backed by three services calling roughly forty endpoints. Every one of
 * those endpoints had already been deleted from the server, and the screens stayed
 * because nobody had decided what to put in their place — so the app shipped a menu
 * that led to error messages.
 *
 * What is here now is what the rebuilt schema can answer: the due queue, a search, one
 * site, the import rejects, the schedule, and a driver's day. The rest went with tables
 * deliberately excluded from the new model (DATA_MODEL §12) — the inventory tables had
 * zero legacy rows, and the compliance calendar modelled an inspection schedule the
 * business does not run. They come back when the feature does, not before.
 *
 * The menu is filtered by role, and the default route is chosen by role too. That is not
 * decoration: a driver who lands on the due queue sees a list of 7,266 sites they cannot
 * act on and no way to find the four they were sent to, and the reason the driver role
 * exists at all is that those are different jobs.
 */

const DRAWER_WIDTH = 240;

const MENU: {
  text: string; icon: React.ReactElement; path: string; roles?: readonly string[];
}[] = [
  { text: 'My day', icon: <DispatchIcon />, path: '/dispatch' },
  { text: 'Schedule', icon: <RoutesIcon />, path: '/routes', roles: OFFICE },
  { text: 'Due queue', icon: <DueQueueIcon />, path: '/due-queue', roles: OFFICE },
  // BIL-19: done and unbilled is revenue walking away — the queue that
  // says so sits next to the queue that says who is due.
  { text: 'Billing queue', icon: <BillingQueueIcon />, path: '/unbilled', roles: OFFICE },
  { text: 'Find a site', icon: <SearchIcon />, path: '/search' },
  { text: 'Import rejects', icon: <QuarantineIcon />, path: '/quarantine', roles: OFFICE },
  { text: 'State report', icon: <LedgerIcon />, path: '/ledger-report', roles: OFFICE },
  { text: 'Invoices', icon: <InvoicesIcon />, path: '/invoices', roles: OFFICE },
  { text: 'Accounts receivable', icon: <ReceivablesIcon />, path: '/receivables', roles: OFFICE },
  // Quotes precede invoices: the bid desk sits where the money decision is made.
  { text: 'Bids', icon: <BidsIcon />, path: '/bids', roles: OFFICE },
  // The list bids are built from (BIL-17): managed by the people bidding.
  { text: 'Price list', icon: <PriceListIcon />, path: '/price-list', roles: OFFICE },
  // Company-wide decisions (sales tax, payment terms) set once, in the open.
  { text: 'Company settings', icon: <SettingsIcon />, path: '/settings', roles: OFFICE },
  // The vocabulary the compliance record is judged against (LED-07). It was
  // 105 legacy strings with no surface to tidy them; this is the surface.
  { text: 'Disposal sites', icon: <DisposalIcon />, path: '/disposal-sites', roles: OFFICE },
  { text: 'Accounts', icon: <UsersIcon />, path: '/accounts', roles: ['admin'] },
];

const MainMenu: React.FC<{ user: User | null; children: React.ReactNode }> = ({ user, children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Filtered rather than hidden-with-a-disabled-entry. A menu item that is greyed out still
  // tells a driver that a screen exists which they are not allowed to see, and invites the
  // question of why; the honest answer is that it is a different job, not a punishment.
  const menu = MENU.filter((m) => !m.roles || (user?.role && m.roles.includes(user.role)));

  const logout = () => {
    authService.logout();
    navigate('/login');
  };

  const drawer = (
    <Box>
      <Toolbar sx={{ bgcolor: 'primary.main', color: 'white' }}>
        <LockOutlined sx={{ mr: 1 }} />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6" noWrap>{DEFAULT_COMPANY_NAME}</Typography>
          <Typography variant="caption" display="block" sx={{ opacity: 0.9 }}>
            {user?.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : 'User'}
          </Typography>
        </Box>
      </Toolbar>
      <Divider />
      <List>
        {menu.map((item) => (
          <ListItemButton
            key={item.path}
            component={Link}
            to={item.path}
            selected={location.pathname.startsWith(item.path)}
          >
            <ListItemIcon>{item.icon}</ListItemIcon>
            <ListItemText primary={item.text} />
          </ListItemButton>
        ))}
      </List>
      <Divider />
      <List>
        <ListItemButton onClick={logout}>
          <ListItemIcon>
            <LogoutIcon />
          </ListItemIcon>
          <ListItemText primary="Log out" />
        </ListItemButton>
      </List>
    </Box>
  );

  const title = menu.find((m) => location.pathname.startsWith(m.path))?.text
    || DEFAULT_COMPANY_NAME;

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <CssBaseline />
      <AppBar position="fixed" sx={{ width: { sm: `calc(100% - ${DRAWER_WIDTH}px)` }, ml: { sm: DRAWER_WIDTH } }}>
        <Toolbar>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="open navigation"
            sx={{ mr: 2, display: { sm: 'none' } }}
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flexGrow: 1 }} noWrap>{title}</Typography>
          <Chip
            size="small"
            color="primary"
            avatar={<Avatar sx={{ width: 22, height: 22, fontSize: 12 }}>{user?.first_name?.[0] || '?'}</Avatar>}
            label={user ? `${user.first_name} ${user.last_name}` : ''}
          />
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { sm: DRAWER_WIDTH }, flexShrink: { sm: 1 } }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
        >
          {drawer}
        </Drawer>
        <Drawer
          variant="permanent"
          sx={{ display: { xs: 'none', sm: 'block' }, '& .MuiDrawer-paper': { boxSizing: 'border-box', width: DRAWER_WIDTH } }}
          open
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{ flexGrow: 1, p: 3, width: { sm: `calc(100% - ${DRAWER_WIDTH}px)` }, mt: 8 }}
      >
        <Container maxWidth="lg">{children}</Container>
      </Box>
    </Box>
  );
};

const AppContent: React.FC = () => {
  const user = authService.getUser();
  return (
    <MainMenu user={user}>
      <Routes>
        <Route path="/dispatch" element={<DispatchPage />} />
        <Route path="/routes" element={<RouteComposerPage />} />
        <Route path="/due-queue" element={<DueQueuePage />} />
        <Route path="/unbilled" element={<UnbilledWorkPage />} />
        <Route path="/search" element={<SiteSearchPage />} />
        <Route path="/quarantine" element={<QuarantinePage />} />
        <Route path="/ledger-report" element={<LedgerReportPage />} />
        <Route path="/invoices" element={<InvoicesPage />} />
        <Route path="/invoices/:id/print" element={<PrintInvoicePage />} />
        <Route path="/receivables" element={<ReceivablesPage />} />
        <Route path="/bids" element={<BidsPage />} />
        <Route path="/bids/:id" element={<BidDetailPage />} />
        <Route path="/bids/:id/print" element={<BidPrintPage />} />
        <Route path="/price-list" element={<PriceListPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/disposal-sites" element={<DisposalSitesPage />} />
        <Route path="/accounts" element={<UsersPage />} />
        <Route path="/properties/:id" element={<PropertyDetailPage />} />
        {/* By role, not one landing page for everyone. A driver opening the app in a driveway
            should be looking at their day, and the reason the endpoint returns the whole day in
            one request is that this is the screen they arrive on. */}
        <Route path="/" element={<Navigate to={homeFor(user?.role)} replace />} />
        <Route
          path="*"
          element={
            <Box>
              <Typography variant="h5" gutterBottom>That screen is not here yet</Typography>
              <Typography color="text.secondary" sx={{ mb: 2 }}>
                The pages this app used to link to were removed with the tables they read.
                Nothing was renamed to hide that.
              </Typography>
              <Button component={Link} to={homeFor(user?.role)} variant="contained">
                Go home
              </Button>
            </Box>
          }
        />
      </Routes>
    </MainMenu>
  );
};

const App: React.FC = () => (
  <Router>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <AuthenticatedRoute>
            <AppContent />
          </AuthenticatedRoute>
        }
      />
    </Routes>
  </Router>
);

export default App;
