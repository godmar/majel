import * as React from "react";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useColorScheme } from "@mui/material/styles";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutlined";
import Brightness4Icon from "@mui/icons-material/Brightness4";
import Brightness7Icon from "@mui/icons-material/Brightness7";
import DnsIcon from "@mui/icons-material/Dns";
import ListAltIcon from "@mui/icons-material/ListAlt";
import LogoutIcon from "@mui/icons-material/Logout";
import MenuIcon from "@mui/icons-material/Menu";
import PeopleIcon from "@mui/icons-material/People";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import { Form, NavLink, useLocation } from "react-router";

const DRAWER_WIDTH = 240;

interface ShellUser {
  username: string;
  displayName: string | null;
  role: "admin" | "user";
}

function ColorModeToggle() {
  const { mode, setMode } = useColorScheme();
  const dark = mode === "dark";
  return (
    <Tooltip title={dark ? "Switch to light mode" : "Switch to dark mode"}>
      <IconButton color="inherit" onClick={() => setMode(dark ? "light" : "dark")}>
        {dark ? <Brightness7Icon /> : <Brightness4Icon />}
      </IconButton>
    </Tooltip>
  );
}

interface NavItem {
  label: string;
  to: string;
  icon: React.ReactNode;
}

const userNav: NavItem[] = [
  { label: "Tasks", to: "/", icon: <ListAltIcon /> },
  { label: "New Task", to: "/tasks/new", icon: <AddCircleOutlineIcon /> },
];

const adminNav: NavItem[] = [
  { label: "Users", to: "/admin/users", icon: <PeopleIcon /> },
  { label: "Agents", to: "/admin/agents", icon: <SmartToyIcon /> },
  { label: "MCP Servers", to: "/admin/mcp-servers", icon: <DnsIcon /> },
];

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate: () => void }) {
  const location = useLocation();
  return (
    <>
      {items.map((item) => (
        <ListItemButton
          key={item.to}
          component={NavLink}
          to={item.to}
          onClick={onNavigate}
          selected={
            item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to)
          }
        >
          <ListItemIcon>{item.icon}</ListItemIcon>
          <ListItemText primary={item.label} />
        </ListItemButton>
      ))}
    </>
  );
}

export default function AppShell({
  user,
  children,
}: {
  user: ShellUser;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [menuAnchor, setMenuAnchor] = React.useState<null | HTMLElement>(null);
  const closeDrawer = () => setMobileOpen(false);

  const drawer = (
    <Box sx={{ overflow: "auto" }}>
      <Toolbar />
      <List>
        <NavList items={userNav} onNavigate={closeDrawer} />
      </List>
      {user.role === "admin" && (
        <>
          <Divider />
          <List subheader={<ListSubheader>Administration</ListSubheader>}>
            <NavList items={adminNav} onNavigate={closeDrawer} />
          </List>
        </>
      )}
    </Box>
  );

  return (
    <Box sx={{ display: "flex" }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar>
          <IconButton
            color="inherit"
            edge="start"
            onClick={() => setMobileOpen(!mobileOpen)}
            sx={{ mr: 2, display: { md: "none" } }}
            aria-label="open navigation"
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
            VT Library AI Agents
          </Typography>
          <ColorModeToggle />
          <Tooltip title={user.displayName ?? user.username}>
            <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} sx={{ ml: 1 }}>
              <Avatar sx={{ width: 32, height: 32, bgcolor: "secondary.main" }}>
                {user.username.slice(0, 1).toUpperCase()}
              </Avatar>
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={menuAnchor}
            open={Boolean(menuAnchor)}
            onClose={() => setMenuAnchor(null)}
          >
            <MenuItem disabled>
              {user.username}
              {user.role === "admin" ? " (admin)" : ""}
            </MenuItem>
            <Form method="post" action="/logout">
              <MenuItem component="button" type="submit" sx={{ width: "100%" }}>
                <ListItemIcon>
                  <LogoutIcon fontSize="small" />
                </ListItemIcon>
                Sign out
              </MenuItem>
            </Form>
          </Menu>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={closeDrawer}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: "block", md: "none" },
          "& .MuiDrawer-paper": { width: DRAWER_WIDTH },
        }}
      >
        {drawer}
      </Drawer>
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: "none", md: "block" },
          width: DRAWER_WIDTH,
          flexShrink: 0,
          "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" },
        }}
        open
      >
        {drawer}
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, md: 3 }, minWidth: 0 }}>
        <Toolbar />
        {children}
      </Box>
    </Box>
  );
}
