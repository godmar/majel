import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: "data" },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#861F41" }, // VT Chicago maroon
        secondary: { main: "#E5751F" }, // VT burnt orange
      },
    },
    dark: {
      palette: {
        primary: { main: "#CE0058" },
        secondary: { main: "#E5751F" },
      },
    },
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
  },
});
